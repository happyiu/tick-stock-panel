"""在单只标的 K 线历史上计算策略信号。

图表只需要信号发生的 K 线, 不需要把完整的选股结果搬到前端。这里复用
StrategyEngine 已加载的策略定义、参数覆盖和矩阵/表达式执行契约, 只负责把
历史策略结果投影成图表可用的入场/退出标记。
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

import polars as pl

from app.backtest.strategy import _basic_filter_for_asset
from app.services.screener import (
    _aggregate_weekly_strategy_frame,
    _prepare_30m_strategy_frame,
)

SUPPORTED_TIMEFRAMES = ("1d", "1w", "30m")
_THIRTY_MINUTE_BARS_PER_SESSION = 8


def _resolve_signal_column(signal: str) -> str:
    return signal if signal.startswith(("signal_", "csg_")) else f"signal_{signal}"


def _signal_mask(frame: pl.DataFrame, signals: list[str], name: str) -> pl.Series:
    """按策略引擎同口径合并信号列; 多个信号为 OR。"""
    masks: list[pl.Series] = []
    for signal in signals:
        column = _resolve_signal_column(signal)
        if column in frame.columns:
            masks.append(frame[column].fill_null(False).cast(pl.Boolean))
    if not masks:
        return pl.Series(name, [False] * len(frame), dtype=pl.Boolean)
    result = masks[0]
    for mask in masks[1:]:
        result = result | mask
    return result.alias(name)


def _active_signals(row: dict[str, Any], signals: list[str]) -> list[str]:
    return [signal for signal in signals if bool(row.get(_resolve_signal_column(signal), False))]


def _format_bar_date(value: Any, timeframe: str) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M" if timeframe == "30m" else "%Y-%m-%d")
    if isinstance(value, date):
        return value.isoformat()
    text = str(value).replace("T", " ")
    return text[:16] if timeframe == "30m" else text[:10]


def _as_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value or "")[:10]
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def _matrix_time_key(value: Any) -> str:
    return str(value)[:19]


def _effective_basic_filter(strategy: Any, overrides: dict, asset_type: str) -> dict:
    basic_filter = dict(strategy.basic_filter or {})
    override_filter = overrides.get("basic_filter")
    if isinstance(override_filter, dict):
        basic_filter.update(override_filter)
    return _basic_filter_for_asset(basic_filter, asset_type)


def _row_label(row: dict[str, Any], timestamp_col: str, timeframe: str) -> str:
    # 周线策略上下文会把当前未完周的 date 设为 as_of, 而图表周K用实际
    # period_end 作为类目键。优先 period_end 可避免标记落在不存在的类目上。
    value = row.get("period_end") if timeframe == "1w" else row.get(timestamp_col)
    if value is None:
        value = row.get(timestamp_col)
    return _format_bar_date(value, timeframe)


def _row_in_range(row: dict[str, Any], timestamp_col: str, start: date, end: date) -> bool:
    value = _as_date(row.get(timestamp_col))
    return value is not None and start <= value <= end


def _markers_from_rows(
    rows: pl.DataFrame,
    *,
    timestamp_col: str,
    timeframe: str,
    kind: str,
    signals: list[str],
    start: date,
    end: date,
) -> list[dict[str, Any]]:
    if rows.is_empty():
        return []
    result: list[dict[str, Any]] = []
    for row in rows.iter_rows(named=True):
        if not _row_in_range(row, timestamp_col, start, end):
            continue
        active = _active_signals(row, signals)
        # 声明了信号列但本根没有任何信号时, 不能把候选行误画成命中。
        if signals and not active:
            continue
        result.append(
            {
                "date": _row_label(row, timestamp_col, timeframe),
                "kind": kind,
                "signals": active,
            }
        )
    return result


def _evaluate_matrix_strategy(
    engine: Any,
    strategy: Any,
    frame: pl.DataFrame,
    *,
    symbol: str,
    asset_type: str,
    timeframe: str,
    overrides: dict,
    params: dict,
    start: date,
    end: date,
) -> list[dict[str, Any]]:
    from app.backtest.matrix import (
        MatrixPipelineConfig,
        MatrixStrategyPipeline,
        build_market_data_matrix,
    )
    from app.strategy.scoring import effective_scoring, effective_scoring_directions

    field_columns = engine._matrix_field_columns(strategy, overrides, params)
    market = build_market_data_matrix(frame, field_columns=field_columns)
    basic_filter = _effective_basic_filter(strategy, overrides, asset_type)
    signals = MatrixStrategyPipeline().run(
        strategy.matrix_strategy,
        market,
        params,
        MatrixPipelineConfig(
            basic_filter=basic_filter,
            scoring=effective_scoring(strategy.meta.get("scoring"), overrides),
            scoring_directions=effective_scoring_directions(overrides),
            order_by=strategy.meta.get("order_by"),
            descending=bool(strategy.meta.get("descending", True)),
        ),
    )

    timestamp_col = "datetime" if "datetime" in frame.columns else "date"
    row_by_time = {_matrix_time_key(row[timestamp_col]): row for row in frame.iter_rows(named=True)}
    try:
        asset_id = market.symbols.index(symbol)
    except ValueError:
        return []

    result: list[dict[str, Any]] = []
    for time_id, timestamp_label in enumerate(market.timestamp_labels):
        row = row_by_time.get(_matrix_time_key(timestamp_label))
        if row is None or not _row_in_range(row, timestamp_col, start, end):
            continue
        if bool(signals.entry[time_id, asset_id]):
            code = int(signals.entry_signal_code[time_id, asset_id])
            entry_signals = (
                [signals.entry_signal_ids[code]]
                if 0 <= code < len(signals.entry_signal_ids)
                else []
            )
            result.append(
                {
                    "date": _row_label(row, timestamp_col, timeframe),
                    "kind": "entry",
                    "signals": entry_signals,
                }
            )
        if bool(signals.exit[time_id, asset_id]):
            code = int(signals.exit_signal_code[time_id, asset_id])
            exit_signals = (
                [signals.exit_signal_ids[code]] if 0 <= code < len(signals.exit_signal_ids) else []
            )
            result.append(
                {
                    "date": _row_label(row, timestamp_col, timeframe),
                    "kind": "exit",
                    "signals": exit_signals,
                }
            )
    return result


def _apply_basic_filter(engine: Any, frame: pl.DataFrame, basic_filter: dict) -> pl.DataFrame:
    if not basic_filter or not basic_filter.get("enabled", True):
        return frame
    expr = engine._basic_filter_expr(frame, basic_filter)
    return frame if expr is None else frame.filter(expr)


def _evaluate_expression_strategy(
    engine: Any,
    strategy: Any,
    frame: pl.DataFrame,
    *,
    symbol: str,
    asset_type: str,
    timeframe: str,
    overrides: dict,
    params: dict,
    start: date,
    end: date,
) -> list[dict[str, Any]]:
    timestamp_col = "datetime" if "datetime" in frame.columns else "date"
    frame = frame.sort(["symbol", timestamp_col])
    basic_filter = _effective_basic_filter(strategy, overrides, asset_type)

    if strategy.filter_history_fn is not None:
        candidate = strategy.filter_history_fn(frame, params)
        if not isinstance(candidate, pl.DataFrame):
            raise ValueError("策略历史过滤器必须返回 Polars DataFrame")
        candidate = _apply_basic_filter(engine, candidate, basic_filter)
    elif strategy.filter_fn is not None:
        filtered = _apply_basic_filter(engine, frame, basic_filter)
        candidate = filtered.filter(strategy.filter_fn(filtered, params))
    else:
        candidate = frame.head(0)

    candidate = candidate.filter(pl.col("symbol").cast(pl.Utf8) == symbol)
    exits = frame.filter(pl.col("symbol").cast(pl.Utf8) == symbol)
    entry_signals = engine._effective_signals(overrides, "entry_signals", strategy.entry_signals)
    exit_signals = engine._effective_signals(overrides, "exit_signals", strategy.exit_signals)

    if entry_signals:
        entry_mask = _signal_mask(candidate, entry_signals, "_entry_signal")
        candidate = candidate.filter(entry_mask)
    entry_markers = _markers_from_rows(
        candidate,
        timestamp_col=timestamp_col,
        timeframe=timeframe,
        kind="entry",
        signals=entry_signals,
        start=start,
        end=end,
    )
    exit_mask = _signal_mask(exits, exit_signals, "_exit_signal")
    exit_rows = exits.filter(exit_mask)
    exit_markers = _markers_from_rows(
        exit_rows,
        timestamp_col=timestamp_col,
        timeframe=timeframe,
        kind="exit",
        signals=exit_signals,
        start=start,
        end=end,
    )
    return [*entry_markers, *exit_markers]


def _load_child_override(engine: Any, strategy_id: str) -> dict:
    loader = getattr(engine, "_override_loader", None)
    if loader is None:
        return {}
    try:
        loaded = loader(strategy_id)
    except Exception:
        return {}
    return dict(loaded) if isinstance(loaded, dict) else {}


def _evaluate_composite_strategy(
    engine: Any,
    strategy: Any,
    frame: pl.DataFrame,
    *,
    symbol: str,
    asset_type: str,
    timeframe: str,
    overrides: dict,
    params: dict,
    start: date,
    end: date,
) -> list[dict[str, Any]]:
    from app.strategy.engine import _parse_composite_children

    if strategy.composite is None:
        return []
    raw_children = overrides.get("children")
    children = (
        _parse_composite_children(raw_children).children
        if isinstance(raw_children, list) and raw_children
        else strategy.composite.children
    )
    child_markers: list[list[dict[str, Any]]] = []
    for child in children:
        child_def = engine.get(child.strategy_id)
        child_override = _load_child_override(engine, child.strategy_id)
        if isinstance(overrides.get("basic_filter"), dict):
            child_override["basic_filter"] = overrides["basic_filter"]
        child_markers.append(
            _evaluate_strategy(
                engine,
                child_def,
                frame,
                symbol=symbol,
                asset_type=asset_type,
                timeframe=timeframe,
                overrides=child_override,
                params=engine.resolve_params(child_def, overrides=child_override),
                start=start,
                end=end,
            )
        )

    entry_by_date: dict[str, list[dict[str, Any]]] = {}
    exit_by_date: dict[str, list[dict[str, Any]]] = {}
    for markers in child_markers:
        for marker in markers:
            target = entry_by_date if marker["kind"] == "entry" else exit_by_date
            target.setdefault(marker["date"], []).append(marker)

    merge_mode = str(params.get("merge_mode") or "union")
    min_confirm = int(params.get("min_confirm") or 0)
    required = max(min_confirm, 1) if min_confirm > 0 else len(children)
    entries: list[dict[str, Any]] = []
    for label, markers in entry_by_date.items():
        if merge_mode == "intersect" and len(markers) < required:
            continue
        entries.append(
            {
                "date": label,
                "kind": "entry",
                "signals": _unique_signals(markers),
            }
        )
    exits = [
        {"date": label, "kind": "exit", "signals": _unique_signals(markers)}
        for label, markers in exit_by_date.items()
    ]
    return [*entries, *exits]


def _unique_signals(markers: list[dict[str, Any]]) -> list[str]:
    result: list[str] = []
    for marker in markers:
        for signal in marker.get("signals", []):
            if signal not in result:
                result.append(signal)
    return result


def _evaluate_strategy(
    engine: Any,
    strategy: Any,
    frame: pl.DataFrame,
    *,
    symbol: str,
    asset_type: str,
    timeframe: str,
    overrides: dict,
    params: dict,
    start: date,
    end: date,
) -> list[dict[str, Any]]:
    if strategy.execution_backend == "matrix_native":
        return _evaluate_matrix_strategy(
            engine,
            strategy,
            frame,
            symbol=symbol,
            asset_type=asset_type,
            timeframe=timeframe,
            overrides=overrides,
            params=params,
            start=start,
            end=end,
        )
    if strategy.execution_backend in {"polars_expr", "python_history_legacy"}:
        return _evaluate_expression_strategy(
            engine,
            strategy,
            frame,
            symbol=symbol,
            asset_type=asset_type,
            timeframe=timeframe,
            overrides=overrides,
            params=params,
            start=start,
            end=end,
        )
    if strategy.execution_backend == "composite":
        return _evaluate_composite_strategy(
            engine,
            strategy,
            frame,
            symbol=symbol,
            asset_type=asset_type,
            timeframe=timeframe,
            overrides=overrides,
            params=params,
            start=start,
            end=end,
        )
    raise ValueError(f"策略执行后端 {strategy.execution_backend!r} 暂不支持 K 线标记")


class StrategyChartService:
    """加载与当前图表相同资产/周期的策略历史。"""

    def __init__(self, repo: Any, engine: Any) -> None:
        self.repo = repo
        self.engine = engine

    def load_frame(
        self,
        *,
        symbol: str,
        asset_type: str,
        timeframe: str,
        start: date,
        end: date,
        required_bars: int,
        days: int,
    ) -> pl.DataFrame:
        if timeframe not in SUPPORTED_TIMEFRAMES:
            raise ValueError(f"当前 K 线不支持 {timeframe} 策略")

        if timeframe == "1d":
            warmup_start = start - timedelta(days=max(180, required_bars * 4))
            frame = self.repo.get_daily_asset(asset_type, symbol, warmup_start, end)
        elif timeframe == "1w":
            warmup_start = start - timedelta(days=max(730, required_bars * 10))
            daily = self.repo.get_daily_asset(asset_type, symbol, warmup_start, end)
            frame = _aggregate_weekly_strategy_frame(daily, end)
        else:
            sessions = max(
                20,
                (required_bars + _THIRTY_MINUTE_BARS_PER_SESSION - 1)
                // _THIRTY_MINUTE_BARS_PER_SESSION
                + 5,
            )
            warmup_start = start - timedelta(days=sessions * 2 + 10)
            try:
                minute = self.repo.get_minute_range(
                    [symbol], warmup_start, end, asset_type=asset_type
                )
            except TypeError:
                minute = self.repo.get_minute_range([symbol], warmup_start, end)
            if minute.is_empty():
                raise ValueError("无 30F 分钟K数据 — 请先在 数据→分钟K 完成对应资产的历史同步")
            frame = _prepare_30m_strategy_frame(minute)

        if frame.is_empty():
            return frame
        if "symbol" in frame.columns:
            frame = frame.filter(pl.col("symbol").cast(pl.Utf8) == symbol)
        timestamp_col = "datetime" if "datetime" in frame.columns else "date"
        if timestamp_col not in frame.columns:
            return pl.DataFrame()
        return frame.sort(["symbol", timestamp_col])

    def signals(
        self,
        *,
        strategy_id: str,
        symbol: str,
        asset_type: str,
        timeframe: str,
        start: date,
        end: date,
        days: int = 20,
    ) -> list[dict[str, Any]]:
        strategy = self.engine.get(strategy_id)
        overrides = _load_child_override(self.engine, strategy_id)
        params = self.engine.resolve_params(strategy, overrides=overrides)
        required_bars = self.engine.required_history_bars(
            [strategy_id],
            params_map={strategy_id: params},
            overrides_map={strategy_id: overrides},
        )
        frame = self.load_frame(
            symbol=symbol,
            asset_type=asset_type,
            timeframe=timeframe,
            start=start,
            end=end,
            required_bars=required_bars,
            days=days,
        )
        if frame.is_empty():
            return []
        markers = _evaluate_strategy(
            self.engine,
            strategy,
            frame,
            symbol=symbol,
            asset_type=asset_type,
            timeframe=timeframe,
            overrides=overrides,
            params=params,
            start=start,
            end=end,
        )
        if timeframe != "30m":
            return markers

        # /api/kline/period 的 30F 返回最近 N 个实际交易日; 策略接口保持同一
        # 可见窗口, 避免历史暖机信号跑到图表类目之外。
        timestamp_col = "datetime" if "datetime" in frame.columns else "date"
        visible_dates = sorted(
            value
            for value in (_as_date(item) for item in frame[timestamp_col].unique().to_list())
            if value is not None
        )
        visible_set = {value.isoformat() for value in visible_dates[-max(1, days) :]}
        return [marker for marker in markers if marker["date"][:10] in visible_set]


def evaluate_strategy_frame(
    engine: Any,
    strategy: Any,
    frame: pl.DataFrame,
    *,
    symbol: str,
    asset_type: str,
    timeframe: str,
    start: date,
    end: date,
    overrides: dict | None = None,
    params: dict | None = None,
) -> list[dict[str, Any]]:
    """测试与离线调用使用的纯帧入口。"""
    effective_overrides = dict(overrides or {})
    resolved_params = engine.resolve_params(
        strategy,
        params=params,
        overrides=effective_overrides,
    )
    return _evaluate_strategy(
        engine,
        strategy,
        frame,
        symbol=symbol,
        asset_type=asset_type,
        timeframe=timeframe,
        overrides=effective_overrides,
        params=resolved_params,
        start=start,
        end=end,
    )
