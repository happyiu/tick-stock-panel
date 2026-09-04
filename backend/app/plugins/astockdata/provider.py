# ruff: noqa: RUF001, RUF002, RUF003

"""将 a-stock-data 的行情层接入 tick-stock-panel 标准 Provider 契约。

来源与口径对齐 a-stock-data:

* mootdx: 通达信 TCP 行情，返回不复权日K/分钟K；
* 新浪: qfq/hfq 阶梯因子，转换为项目需要的单事件 ex_factor；
* 腾讯: GBK 编码的批量实时行情。

这里只接入系统已有的四类标准数据集。研报、资金流、新闻、公告等端点仍需要
各自的 service/API 契约，不在插件里偷偷扩展成未注册的字段。
"""

from __future__ import annotations

import contextlib
import importlib
import json
import logging
import math
import re
import socket
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from datetime import time as dt_time
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import polars as pl

from app.config import settings
from app.data_providers.base import AssetType
from app.data_providers.normalizer import normalize_adj_factors, normalize_daily
from app.tickflow.rate_limits import chunked

logger = logging.getLogger(__name__)

_DATASETS = ("daily", "adj_factor", "minute", "realtime")
_BATCH = 40
_REALTIME_BATCH = 200
_TDX_PAGE_SIZE = 800  # mootdx StdQuotes.bars() 对 offset 的硬上限
_MAX_TDX_BARS = 8_000
_TENCENT_MINUTE_BARS = 320  # 腾讯分钟接口的稳定上限；只作为通达信降级源
_BEIJING = ZoneInfo("Asia/Shanghai")
_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

# a-stock-data 的 tdx_client() 候选服务器。每台必须经过真实 K 线验活，不能只看 TCP 握手。
_TDX_SERVERS = [
    ("119.97.185.59", 7709),
    ("124.70.133.119", 7709),
    ("116.205.183.150", 7709),
    ("123.60.73.44", 7709),
    ("116.205.163.254", 7709),
    ("121.36.225.169", 7709),
    ("123.60.70.228", 7709),
    ("124.71.9.153", 7709),
    ("110.41.147.114", 7709),
    ("124.71.187.122", 7709),
]

_FREQUENCIES = {
    "1m": (8, 240),
    "5m": (0, 48),
    "15m": (1, 16),
    "30m": (2, 8),
    "60m": (3, 4),
}
_SH_INDEX = {"000300", "000905", "000016", "000688", "000852", "000010"}
_TICKER_RE = re.compile(r"^(?:(sh|sz|bj)(\d{6})|(\d{6})(?:\.(sh|sz|bj))?)$", re.IGNORECASE)
_HTTP_SESSION: Any = None


@dataclass
class _AStockDataConfig:
    """让 custom loader 能识别内置 provider。"""

    name: str = "astockdata"
    display_name: str = "a-stock-data（多源行情）"
    datasets: dict = field(default_factory=lambda: dict.fromkeys(_DATASETS))
    path: None = None
    builtin: bool = True


def availability() -> tuple[bool, str]:
    """检查依赖是否能导入，不发网络请求。"""
    for module_name in ("mootdx.quotes", "requests"):
        try:
            importlib.import_module(module_name)
        except ModuleNotFoundError:
            return False, f"缺少 Python 依赖: {module_name.split('.')[0]}"
        except Exception as exc:
            return False, f"Python 依赖 {module_name} 加载失败: {exc}"
    return True, "ok"


def _http_get(url: str, **kwargs):
    """复用 HTTP 会话；独立成函数方便无网络单测。"""
    global _HTTP_SESSION
    if _HTTP_SESSION is None:
        import requests

        _HTTP_SESSION = requests.Session()
        _HTTP_SESSION.headers.update({"User-Agent": _UA})
    return _HTTP_SESSION.get(url, **kwargs)


def _natural_market(code: str) -> str:
    if code.startswith("92") or code.startswith(("4", "8")):
        return "bj"
    if code.startswith(("5", "6", "9")):
        return "sh"
    return "sz"


def _symbol_parts(raw: Any) -> tuple[str, str, str]:
    """解析项目 symbol，返回 (纯代码, 小写市场, 标准 symbol)。"""
    text = str(raw).strip()
    match = _TICKER_RE.fullmatch(text)
    if not match:
        raise ValueError(f"无法把 {raw!r} 解析为 6 位股票代码；支持 600519 / SH600519 / 600519.SH")
    code = match.group(2) or match.group(3)
    market = (match.group(1) or match.group(4) or "").lower()
    if market:
        if code.startswith("000"):
            if market == "bj":
                raise ValueError(f"{raw!r} 市场标识与号段矛盾")
        elif market != _natural_market(code):
            raise ValueError(f"{raw!r} 的市场标识与号段矛盾")
    else:
        market = "sh" if code in _SH_INDEX else _natural_market(code)
    return code, market, f"{code}.{market.upper()}"


def _as_beijing(value: datetime | date | None) -> datetime | date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            return value.astimezone(_BEIJING).replace(tzinfo=None)
        return value
    return value


def _date_value(value: datetime | date | None) -> date | None:
    value = _as_beijing(value)
    return value.date() if isinstance(value, datetime) else value


def _window(
    start_time: datetime | None,
    end_time: datetime | None,
    default_days: int,
) -> tuple[date, date]:
    end = _date_value(end_time) or datetime.now(_BEIJING).date()
    start = _date_value(start_time) or (end - timedelta(days=default_days))
    return start, end


def _datetime_window(
    start_time: datetime | None,
    end_time: datetime | None,
    start_date: date,
    end_date: date,
) -> tuple[datetime, datetime]:
    start = _as_beijing(start_time)
    end = _as_beijing(end_time)
    return (
        start if isinstance(start, datetime) else datetime.combine(start_date, dt_time.min),
        end if isinstance(end, datetime) else datetime.combine(end_date, dt_time.max),
    )


def _tdx_window(start_date: date, end_date: date, bars_per_day: int) -> tuple[int, int]:
    """把日期范围估算成 mootdx 的 start/offset 窗口，并留周末/节假日余量。"""
    today = datetime.now(_BEIJING).date()
    lag_days = max((today - end_date).days, 0)
    query_start = max(0, int(lag_days * 7 / 5 * bars_per_day) - bars_per_day * 3)
    calendar_days = max((end_date - start_date).days + 1, 1)
    count = int(calendar_days * 7 / 5 * bars_per_day) + bars_per_day * 4
    return query_start, max(count, bars_per_day)


def _has_rows(frame: Any) -> bool:
    if frame is None:
        return False
    if isinstance(frame, pl.DataFrame):
        return not frame.is_empty()
    empty = getattr(frame, "empty", None)
    if isinstance(empty, bool) and empty:
        return False
    try:
        return len(frame) > 0
    except TypeError:
        return True


def _close_tdx(client: Any) -> None:
    close = getattr(client, "close", None)
    if callable(close):
        with contextlib.suppress(Exception):
            close()


def _tdx_validate(client: Any) -> bool:
    try:
        return _has_rows(client.bars(symbol="000001", frequency=9, offset=1))
    except Exception:
        return False


def _tdx_client() -> Any:
    """创建已真实验活的 mootdx client，规避 BESTIP 空串/坏节点静默空表。"""
    from mootdx.quotes import Quotes

    for host, port in _TDX_SERVERS:
        try:
            with socket.create_connection((host, port), timeout=0.7):
                pass
        except Exception:
            continue
        client = None
        try:
            client = Quotes.factory(market="std", server=(host, port), timeout=2.0)
            if _tdx_validate(client):
                return client
        except Exception:
            pass
        _close_tdx(client)

    # 不在业务请求里调用 mootdx 的 bestip 探测：它会同步扫描多组节点，
    # 当前网络不可达时没有可靠的请求级超时；上面的固定候选已覆盖 a-stock-data 的节点。
    raise RuntimeError("所有 mootdx 服务器均无法取到数据；通达信 TCP 7709 在当前网络可能不可达。")


def _tdx_pages(
    client: Any,
    code: str,
    frequency: int,
    start: int,
    count: int,
    asset_type: str,
) -> list[Any]:
    method = client.index_bars if asset_type == "index" else client.bars
    frames: list[Any] = []
    cursor = max(start, 0)
    remaining = min(max(count, 0), _MAX_TDX_BARS)
    while remaining:
        page_size = min(remaining, _TDX_PAGE_SIZE)
        frame = method(symbol=code, frequency=frequency, start=cursor, offset=page_size)
        if not _has_rows(frame):
            break
        frames.append(frame)
        received = len(frame)
        cursor += received
        remaining -= received
        if received < page_size:
            break
    return frames


def _normalise_freq(freq: str) -> tuple[str, int, int]:
    value = str(freq).strip().lower()
    if value.isdigit():
        value = f"{value}m"
    if value == "1h":
        value = "60m"
    if value not in _FREQUENCIES:
        raise ValueError(f"a-stock-data 不支持分钟频率: {freq}")
    frequency, bars_per_day = _FREQUENCIES[value]
    return value, frequency, bars_per_day


def _to_polars_frame(data: Any) -> pl.DataFrame:
    if data is None:
        return pl.DataFrame()
    if isinstance(data, pl.DataFrame):
        return data.clone()
    if hasattr(data, "reset_index"):
        with contextlib.suppress(Exception):
            data = data.reset_index()
        try:
            return pl.from_pandas(data)
        except Exception:
            return pl.DataFrame()
    try:
        return pl.DataFrame(data)
    except Exception:
        return pl.DataFrame()


def _normalise_minute(data: Any, symbol: str) -> pl.DataFrame:
    df = _to_polars_frame(data)
    if df.is_empty():
        return df
    if "datetime" not in df.columns and "index" in df.columns:
        df = df.rename({"index": "datetime"})
    if "datetime" not in df.columns and "date" in df.columns:
        df = df.rename({"date": "datetime"})
    df = df.rename({k: v for k, v in {"vol": "volume", "amt": "amount"}.items() if k in df.columns})
    if "datetime" not in df.columns:
        return pl.DataFrame()

    dtype = df.schema["datetime"]
    if isinstance(dtype, pl.Datetime):
        expr = pl.col("datetime")
        if dtype.time_zone is not None:
            expr = expr.dt.convert_time_zone("Asia/Shanghai").dt.replace_time_zone(None)
        df = df.with_columns(expr.cast(pl.Datetime("us")))
    elif dtype == pl.Date:
        df = df.with_columns(pl.col("datetime").cast(pl.Datetime("us")))
    elif dtype == pl.Utf8:
        df = df.with_columns(pl.col("datetime").str.to_datetime(strict=False))
    else:
        df = df.with_columns(pl.col("datetime").cast(pl.Datetime("us"), strict=False))

    df = df.with_columns(pl.lit(symbol).alias("symbol"))
    for col in ("open", "high", "low", "close", "volume", "amount"):
        if col in df.columns:
            df = df.with_columns(pl.col(col).cast(pl.Float64, strict=False))
    required = ["symbol", "datetime", "open", "high", "low", "close", "volume", "amount"]
    if not all(col in df.columns for col in required):
        return pl.DataFrame()
    return df.select(required).filter(pl.col("datetime").is_not_null())


def _tencent_minute(raw_symbol: str, freq: str) -> pl.DataFrame:
    """通达信不可达时取腾讯最近分钟K；字段 7 是换手率，不是成交额。"""
    freq_name, _, _ = _normalise_freq(freq)
    period = f"m{freq_name[:-1]}"
    code, market, symbol = _symbol_parts(raw_symbol)
    key = f"{market}{code}"
    response = _http_get(
        "https://ifzq.gtimg.cn/appstock/app/kline/mkline"
        f"?param={key},{period},,{_TENCENT_MINUTE_BARS}",
        headers={"User-Agent": _UA, "Referer": "https://gu.qq.com/"},
        timeout=10,
    )
    response.raise_for_status()
    item = (response.json().get("data") or {}).get(key) or {}
    rows: list[dict] = []
    for raw in item.get(period, []) or []:
        if not isinstance(raw, (list, tuple)) or len(raw) < 6:
            continue
        try:
            stamp = datetime.strptime(str(raw[0]), "%Y%m%d%H%M")
            open_price, close, high, low = (float(raw[i]) for i in (1, 2, 3, 4))
            volume = float(raw[5])
        except (TypeError, ValueError):
            continue
        rows.append(
            {
                "datetime": stamp,
                "open": open_price,
                "close": close,
                "high": high,
                "low": low,
                "volume": volume,
                # 腾讯只给成交量(手)，按均价估算成交额(元)；raw[7] 是换手率。
                "amount": volume * 100 * ((open_price + close) / 2),
            }
        )
    return _normalise_minute(rows, symbol)


def _normalise_daily(data: Any, symbol: str) -> pl.DataFrame:
    df = _to_polars_frame(data)
    if df.is_empty():
        return df
    if "date" not in df.columns and "datetime" not in df.columns and "index" in df.columns:
        df = df.rename({"index": "date"})
    return normalize_daily(df, default_symbol=symbol, source="astockdata")


def _number(values: list[str], index: int) -> float | None:
    if index >= len(values) or not values[index]:
        return None
    try:
        value = float(values[index])
        return value if math.isfinite(value) else None
    except (TypeError, ValueError):
        return None


def _parse_tencent(text: str, fetched_ms: int) -> list[dict]:
    rows: list[dict] = []
    for line in str(text).split(";"):
        if "=" not in line or '"' not in line:
            continue
        key = line.split("=", 1)[0].strip().rsplit("_", 1)[-1].lower()
        try:
            code, market, symbol = _symbol_parts(key)
        except ValueError:
            continue
        payload = line.split('"', 2)[1].split("~")
        if len(payload) < 53:
            continue
        amount_wan = _number(payload, 37)
        change_pct = _number(payload, 32)
        amplitude = _number(payload, 43)
        turnover_rate = _number(payload, 38)
        rows.append(
            {
                "symbol": symbol,
                "name": payload[1] or None,
                "last_price": _number(payload, 3),
                "prev_close": _number(payload, 4),
                "open": _number(payload, 5),
                "high": _number(payload, 33),
                "low": _number(payload, 34),
                # 腾讯字段 6 与项目实时/volume_delta 口径均为手，不能再乘/除 100。
                "volume": _number(payload, 6),
                "amount": amount_wan * 10_000 if amount_wan is not None else None,
                "change_amount": _number(payload, 31),
                "change_pct": change_pct / 100 if change_pct is not None else None,
                "amplitude": amplitude / 100 if amplitude is not None else None,
                "turnover_rate": turnover_rate / 100 if turnover_rate is not None else None,
                "timestamp": fetched_ms,
                "limit_up": _number(payload, 47),
                "limit_down": _number(payload, 48),
            }
        )
        # code/market 已由 _symbol_parts 校验；局部变量保留让字段索引解析更易审查。
        del code, market
    return rows


def _factor_events(series: list[dict]) -> list[dict]:
    """将新浪累计 hfq 阶梯值转换为 pipeline 的单事件比值。"""
    previous: float | None = None
    events: list[dict] = []
    ordered = sorted(series, key=lambda item: str(item.get("date", "")))
    for item in ordered:
        try:
            trade_date = date.fromisoformat(str(item["date"])[:10])
            factor = float(item["factor"])
        except (KeyError, TypeError, ValueError):
            continue
        if not math.isfinite(factor) or factor <= 0:
            continue
        if previous is not None and not math.isclose(
            factor, previous, rel_tol=1e-12, abs_tol=1e-12
        ):
            events.append({"trade_date": trade_date, "ex_factor": factor / previous})
        previous = factor
    return events


def _sina_factors(code: str, market: str) -> list[dict]:
    symbol = f"{market}{code}"
    url = f"https://finance.sina.com.cn/realstock/company/{symbol}/hfq.js"
    response = _http_get(
        url,
        headers={"User-Agent": _UA, "Referer": "https://finance.sina.com.cn/"},
        timeout=10,
    )
    response.raise_for_status()
    text = getattr(response, "text", "")
    brace = text.find("{")
    if brace < 0:
        raise RuntimeError(f"新浪复权因子响应无 JSON（{symbol}/hfq）")
    try:
        data, _ = json.JSONDecoder().raw_decode(text[brace:])
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"新浪复权因子 JSON 解析失败（{symbol}/hfq）: {exc}") from exc
    return [{"date": item["d"], "factor": float(item["f"])} for item in data.get("data", [])]


def _instrument_symbols() -> list[str]:
    out: list[str] = []
    data_dir = Path(settings.data_dir)
    for relative in (
        "instruments/instruments.parquet",
        "instruments_etf/instruments_etf.parquet",
        "instruments_index/instruments_index.parquet",
    ):
        path = data_dir / relative
        if not path.exists():
            continue
        try:
            df = pl.read_parquet(path, columns=["symbol"])
        except Exception as exc:
            logger.warning("读取本地 instruments 失败(%s): %s", relative, exc)
            continue
        for raw in df.get_column("symbol").cast(pl.Utf8).unique().to_list():
            try:
                out.append(_symbol_parts(raw)[2])
            except ValueError:
                continue
    return list(dict.fromkeys(out))


class AStockDataProvider:
    """a-stock-data 行情层的标准 Provider。"""

    name = "astockdata"
    builtin = True
    # mootdx 分页有总量上限；与前端分时档位保持一致，默认只请求最近 5 个交易日。
    minute_history_days = 5

    def __init__(self) -> None:
        self.config = _AStockDataConfig()
        self._tdx: Any = None
        self._tdx_unavailable = False
        self._symbols_cache: list[str] | None = None

    def close(self) -> None:
        _close_tdx(self._tdx)
        self._tdx = None
        self._tdx_unavailable = False
        global _HTTP_SESSION
        if _HTTP_SESSION is not None:
            _HTTP_SESSION.close()
            _HTTP_SESSION = None

    def _get_tdx(self) -> Any:
        if self._tdx_unavailable:
            raise RuntimeError("mootdx 通达信连接不可用")
        if self._tdx is None:
            try:
                self._tdx = _tdx_client()
            except Exception:
                self._tdx_unavailable = True
                raise
        return self._tdx

    def get_daily(
        self,
        symbols: list[str],
        start_time: datetime | None,
        end_time: datetime | None,
        asset_type: AssetType = "stock",
        on_chunk_done=None,
    ) -> pl.DataFrame:
        if not symbols:
            return pl.DataFrame()
        start_date, end_date = _window(start_time, end_time, 365)
        if start_date > end_date:
            return pl.DataFrame()
        query_start, count = _tdx_window(start_date, end_date, 1)
        if query_start >= _MAX_TDX_BARS:
            logger.warning("a-stock-data daily 请求范围超出 mootdx 保留窗口")
            return pl.DataFrame()

        frames: list[pl.DataFrame] = []
        chunks = chunked(symbols, _BATCH)
        try:
            client = self._get_tdx()
        except Exception as exc:
            logger.warning("a-stock-data daily mootdx 不可用: %s", exc)
            client = None
        for index, current in enumerate(chunks):
            if client is not None:
                for raw_symbol in current:
                    try:
                        code, _, symbol = _symbol_parts(raw_symbol)
                        pages = _tdx_pages(client, code, 9, query_start, count, str(asset_type))
                        for page in pages:
                            df = _normalise_daily(page, symbol)
                            if not df.is_empty():
                                frames.append(
                                    df.filter(
                                        (pl.col("date") >= start_date)
                                        & (pl.col("date") <= end_date)
                                    ).with_columns(pl.lit(symbol).alias("symbol"))
                                )
                    except Exception as exc:
                        logger.warning("a-stock-data daily %s 拉取失败: %s", raw_symbol, exc)
            if on_chunk_done:
                on_chunk_done(index + 1, len(chunks))
        non_empty = [frame for frame in frames if not frame.is_empty()]
        return pl.concat(non_empty, how="diagonal_relaxed") if non_empty else pl.DataFrame()

    def get_adj_factors(
        self,
        symbols: list[str],
        start_time: datetime | None,
        end_time: datetime | None,
        asset_type: AssetType = "stock",
        on_chunk_done=None,
    ) -> pl.DataFrame:
        if not symbols:
            return pl.DataFrame()
        start_date = _date_value(start_time)
        end_date = _date_value(end_time)
        if start_date and end_date and start_date > end_date:
            return pl.DataFrame()
        rows: list[dict] = []
        chunks = chunked(symbols, _BATCH)
        for index, current in enumerate(chunks):
            for raw_symbol in current:
                try:
                    code, market, symbol = _symbol_parts(raw_symbol)
                    events = _factor_events(_sina_factors(code, market))
                    for event in events:
                        if start_date and event["trade_date"] < start_date:
                            continue
                        if end_date and event["trade_date"] > end_date:
                            continue
                        rows.append({"symbol": symbol, **event})
                except Exception as exc:
                    logger.warning("a-stock-data adj_factor %s 拉取失败: %s", raw_symbol, exc)
            if on_chunk_done:
                on_chunk_done(index + 1, len(chunks))
        return normalize_adj_factors(rows, source=self.name) if rows else pl.DataFrame()

    def get_minute(
        self,
        symbols: list[str],
        start_time: datetime | None,
        end_time: datetime | None,
        asset_type: AssetType = "stock",
        freq: str = "1m",
        on_chunk_done=None,
    ) -> pl.DataFrame:
        if not symbols:
            return pl.DataFrame()
        _, frequency, bars_per_day = _normalise_freq(freq)
        start_date, end_date = _window(start_time, end_time, self.minute_history_days)
        if start_date > end_date:
            return pl.DataFrame()
        query_start, count = _tdx_window(start_date, end_date, bars_per_day)
        try:
            client = self._get_tdx()
        except Exception as exc:
            logger.warning("a-stock-data mootdx 分时不可用，降级腾讯分钟K: %s", exc)
            client = None
        if client is not None and query_start + count > _MAX_TDX_BARS:
            raise ValueError("a-stock-data mootdx 分钟K查询范围超过约一个月，交由 TickFlow 回退")
        start_dt, end_dt = _datetime_window(start_time, end_time, start_date, end_date)
        frames: list[pl.DataFrame] = []
        chunks = chunked(symbols, _BATCH)
        for index, current in enumerate(chunks):
            for raw_symbol in current:
                received = False
                try:
                    if client is not None:
                        code, _, symbol = _symbol_parts(raw_symbol)
                        pages = _tdx_pages(
                            client, code, frequency, query_start, count, str(asset_type)
                        )
                        for page in pages:
                            df = _normalise_minute(page, symbol)
                            if not df.is_empty():
                                filtered = df.filter(
                                    (pl.col("datetime") >= start_dt)
                                    & (pl.col("datetime") <= end_dt)
                                )
                                if not filtered.is_empty():
                                    frames.append(filtered)
                                    received = True
                except Exception as exc:
                    logger.warning("a-stock-data minute %s 拉取失败: %s", raw_symbol, exc)
                if not received:
                    try:
                        df = _tencent_minute(raw_symbol, freq)
                        if not df.is_empty():
                            filtered = df.filter(
                                (pl.col("datetime") >= start_dt) & (pl.col("datetime") <= end_dt)
                            )
                            if not filtered.is_empty():
                                frames.append(filtered)
                    except Exception as exc:
                        logger.warning("a-stock-data 腾讯分钟K %s 拉取失败: %s", raw_symbol, exc)
            if on_chunk_done:
                on_chunk_done(index + 1, len(chunks))
        non_empty = [frame for frame in frames if not frame.is_empty()]
        return pl.concat(non_empty, how="diagonal_relaxed") if non_empty else pl.DataFrame()

    def _all_symbols(self) -> list[str]:
        if self._symbols_cache is not None:
            return self._symbols_cache
        local = _instrument_symbols()
        if local:
            self._symbols_cache = local
            return local
        try:
            client = self._get_tdx()
            out: list[str] = []
            for market_id, market in ((1, "SH"), (0, "SZ")):
                listed = client.stocks(market=market_id)
                frame = _to_polars_frame(listed)
                if frame.is_empty() or "code" not in frame.columns:
                    continue
                for raw_code in frame.get_column("code").cast(pl.Utf8).to_list():
                    code = str(raw_code).zfill(6)
                    try:
                        out.append(_symbol_parts(f"{code}.{market}")[2])
                    except ValueError:
                        continue
            self._symbols_cache = list(dict.fromkeys(out))
        except Exception as exc:
            logger.warning("a-stock-data 无法取得实时标的清单: %s", exc)
            self._symbols_cache = []
        return self._symbols_cache

    def get_realtime(
        self,
        universes: list[str] | None = None,
        symbols: list[str] | None = None,
    ) -> list[dict]:
        wanted = symbols or self._all_symbols()
        query_keys: list[str] = []
        for raw_symbol in wanted:
            try:
                code, market, _ = _symbol_parts(raw_symbol)
                query_keys.append(f"{market}{code}")
            except ValueError:
                continue
        query_keys = list(dict.fromkeys(query_keys))
        if not query_keys:
            logger.warning("a-stock-data realtime 没有可查询的标的")
            return []

        rows: list[dict] = []
        for index in range(0, len(query_keys), _REALTIME_BATCH):
            if index:
                time.sleep(0.05)
            batch = query_keys[index : index + _REALTIME_BATCH]
            try:
                response = _http_get(
                    "https://qt.gtimg.cn/q=" + ",".join(batch),
                    headers={"User-Agent": _UA, "Referer": "https://gu.qq.com/"},
                    timeout=10,
                )
                response.raise_for_status()
                content = getattr(response, "content", b"")
                if content:
                    try:
                        payload = content.decode("gbk")
                    except (AttributeError, UnicodeDecodeError):
                        payload = str(getattr(response, "text", ""))
                else:
                    payload = str(getattr(response, "text", ""))
                rows.extend(_parse_tencent(payload, int(time.time() * 1000)))
            except Exception as exc:
                logger.warning("a-stock-data realtime 批次拉取失败: %s", exc)
        return rows

    def test_dataset(self, dataset: str, symbols: list[str] | None = None) -> dict:
        sample = symbols or ["600519.SH"]
        if dataset == "daily":
            return _preview(dataset, self.get_daily(sample, None, None))
        if dataset == "adj_factor":
            return _preview(dataset, self.get_adj_factors(sample, None, None))
        if dataset == "minute":
            return _preview(dataset, self.get_minute(sample, None, None))
        if dataset == "realtime":
            rows = self.get_realtime(symbols=sample)
            return {
                "provider": self.name,
                "dataset": dataset,
                "rows": len(rows),
                "columns": list(rows[0].keys()) if rows else [],
                "preview": rows[:5],
            }
        raise ValueError(f"a-stock-data 不支持数据集: {dataset}")


def _preview(dataset: str, frame: pl.DataFrame) -> dict:
    return {
        "provider": "astockdata",
        "dataset": dataset,
        "rows": frame.height,
        "columns": frame.columns,
        "preview": frame.head(5).to_dicts() if not frame.is_empty() else [],
    }
