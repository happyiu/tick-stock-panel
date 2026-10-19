"""Shared chart candle access; HTTP and indicator workers use identical projections."""
# ruff: noqa: RUF001
from __future__ import annotations

import math
from dataclasses import replace
from datetime import datetime, time, timedelta

import polars as pl

from app.market_time import cn_today
from app.services import preferences
from app.services.chart_data import ChartSnapshot


def chart_snapshot(state, symbol, asset_type, period, start, end, *, max_age_seconds=None):
    service = getattr(state, 'chart_data_service', None)
    if service is None:
        return ChartSnapshot(pl.DataFrame(), '', stale=True)
    provider = preferences.get_chart_data_provider()
    options = {'max_age_seconds': max_age_seconds} if max_age_seconds is not None else {}
    return service.get(provider, provider, symbol, asset_type, period, start, end, **options)


def monitor_capability(state, rule):
    from app.data_providers.capabilities import build_capability_matrix
    from app.tickflow.policy import base_tier_name
    matrix = build_capability_matrix({
        'chart_data_provider': preferences.get_chart_data_provider(),
        'minute_data_provider': preferences.get_minute_data_provider(),
        'realtime_data_provider': preferences.get_realtime_data_provider(),
    }, tickflow_tier=base_tier_name())
    usable = {c['id']: c['usable'] for c in matrix['capabilities']}
    if not usable['chart']:
        return '图表行情能力不可用，请前往数据源配置'
    if rule['period'] == '30m' and not usable['minute']:
        return '分钟数据能力不可用，请前往数据源配置'
    if rule['period'] == '30m':
        from app.services.kline_sync import intraday_monitor_support
        support = intraday_monitor_support(getattr(state, 'capabilities', None))
        monitors = getattr(state, 'indicator_monitor', None)
        symbols = {r['symbol'] for r in monitors.rules() if r['enabled'] and r['period'] == '30m'} if monitors else set()
        symbols.add(rule['symbol'])
        if not support['available'] or len(symbols) > int(support['max_symbols']):
            return '分钟订阅能力不足或监控标的超过当前订阅上限'
    if rule['period'] == '1d' and rule['mode'] != 'confirmed' and not usable['realtime']:
        return '日线盘中预警需要实时行情能力，请前往数据源配置'
    return None


def monitor_snapshot(state, rule, now):
    from app.services.kline_periods import aggregate_minute_30m, prepare_native_30m
    start = datetime.fromisoformat(rule['calc_start']).date() if rule.get('calc_start') else now.date()-timedelta(days=1200 if rule['period'] == '1d' else 120)
    snapshot = chart_snapshot(state, rule['symbol'], rule['asset_type'], rule['period'], start, now.date(), max_age_seconds=60)
    frame = snapshot.frame
    rows = []
    if rule['period'] == '30m':
        # Actual minute coverage, rather than the future 30m display label, confirms a bucket.
        minute_start = now.date() if not frame.is_empty() and not snapshot.stale else start
        minutes = chart_snapshot(state, rule['symbol'], rule['asset_type'], '1m', minute_start, now.date(), max_age_seconds=60)
        if not minutes.frame.is_empty() and minutes.adjustment not in {'none', 'forward'}:
            return dict(rows=[], stale=True, source_context=f'{minutes.provider}:{minutes.adjustment}', data_through=None, reason='分钟数据复权口径未知，请检查数据源声明')
        if not minutes.frame.is_empty():
            minutes = replace(minutes, frame=minutes.frame.filter(pl.col('datetime') <= now.replace(tzinfo=None)))
        if not minutes.frame.is_empty() and not minutes.stale:
            if not frame.is_empty() and snapshot.adjustment != minutes.adjustment:
                return dict(rows=[], stale=True, source_context='mixed-adjustment', data_through=None, reason='历史和实时分钟数据复权口径不一致')
            minute_bars = aggregate_minute_30m(minutes.frame)
            native = prepare_native_30m(frame) if not frame.is_empty() and not snapshot.stale else pl.DataFrame()
            if not native.is_empty():
                minute_bars = pl.concat([native.filter(pl.col('datetime').dt.date() < now.date()), minute_bars], how='diagonal_relaxed').unique(subset=['symbol', 'date'], keep='last').sort('date')
            rows = minute_bars.to_dicts()
            stamps = set(minutes.frame['datetime'].to_list())
            for row in rows:
                end = datetime.fromisoformat(str(row['date']))
                coverage = row.get('period_end')
                coverage = datetime.fromisoformat(str(coverage)) if coverage else None
                expected = {end-timedelta(minutes=i) for i in range(30)}
                row['is_closed'] = end.date() < now.date() or (coverage is not None and expected <= stamps and end <= now.replace(tzinfo=None))
                row['is_fresh'] = coverage is not None and now.replace(tzinfo=None)-coverage <= timedelta(minutes=3)
            snapshot = minutes
        elif not frame.is_empty() and not snapshot.stale:
            rows = prepare_native_30m(frame).to_dicts()
            for row in rows:
                row['is_closed'] = str(row['date'])[:10] < now.date().isoformat()
                row['is_fresh'] = False
    elif not frame.is_empty() and not snapshot.stale:
        rows = frame.to_dicts()
        for row in rows:
            day = str(row['date'])[:10]
            row['date'] = day
            # Require an independently observed 15:00 minute to confirm today's daily bar.
            row['is_closed'] = day < now.date().isoformat()
            row['is_fresh'] = day < now.date().isoformat()
        today_minutes = chart_snapshot(state, rule['symbol'], rule['asset_type'], '1m', now.date(), now.date(), max_age_seconds=60)
        if not today_minutes.frame.is_empty():
            today_minutes = replace(today_minutes, frame=today_minutes.frame.filter(pl.col('datetime') <= now.replace(tzinfo=None)))
        # Today's forward adjustment ratio is one; known raw current-day prices share that anchor.
        if not today_minutes.frame.is_empty() and not today_minutes.stale and today_minutes.adjustment in {'none', 'forward'}:
            end = today_minutes.frame['datetime'].max()
            stamps = set(today_minutes.frame['datetime'].to_list())
            expected = {datetime.combine(now.date(), start)+timedelta(minutes=i) for start in (time(9, 30), time(13)) for i in range(1, 121)}
            daily = today_minutes.frame.sort('datetime').group_by('symbol').agg(
                pl.col('open').first(), pl.col('high').max(), pl.col('low').min(), pl.col('close').last(),
                pl.col('volume').sum(), pl.col('amount').sum() if 'amount' in today_minutes.frame.columns else pl.lit(None).alias('amount'),
            ).to_dicts()[0]
            daily.update(date=now.date().isoformat(), is_closed=expected <= stamps and now.time() >= time(15), is_fresh=True)
            if now.replace(tzinfo=None)-end <= timedelta(minutes=3) or daily['is_closed']:
                rows = [r for r in rows if r['date'] != daily['date']]+[daily]
        elif rule['mode'] != 'confirmed':
            live = latest_live_candle(state, rule['symbol'], rule['asset_type'], refresh_asset=False)
            if live and now.time() < time(15) and live.get('quote_ts') and now.timestamp()*1000-float(live['quote_ts']) <= 180000:
                live['is_closed'] = False
                rows = [r for r in rows if r['date'] != live['date']]+[live]
    for row in rows:
        for key in ('date', 'period_start', 'period_end', 'datetime'):
            if key in row and hasattr(row[key], 'isoformat'):
                row[key] = row[key].isoformat().replace('T', ' ')
        for key, value in row.items():
            if isinstance(value, float) and not math.isfinite(value):
                row[key] = None
    return dict(rows=rows, adjustment=snapshot.adjustment, source_context=f'{snapshot.provider}:{snapshot.adjustment}:{preferences.get_realtime_data_provider() if rule["period"] == "1d" else preferences.get_minute_data_provider()}',
                stale=snapshot.stale, data_through=snapshot.metadata()['data_through'])


def latest_live_candle(
    state,
    symbol: str,
    asset_type: str = "stock",
    *,
    refresh_asset: bool = True,
    today=None,
) -> dict | None:
    """从内存缓存读取单只标的的当日实时 enriched 行。"""

    today = today or cn_today()
    if asset_type == "stock":
        qs = getattr(state, "quote_service", None)
        if not qs:
            return None
        df_today, enriched_date = qs.get_enriched_today()
    elif asset_type in {"etf", "index"}:
        df_today, enriched_date = state.repo.get_enriched_latest_asset(
            asset_type, refresh=refresh_asset,
        )
    else:
        return None
    if df_today.is_empty():
        return None

    # 非交易日(周末/假日)缓存日期 != 北京今天, 跳过注入避免产生重复蜡烛。
    # 必须用 cn_today(): 美洲时区主机整个 A 股交易时段本地日期落后北京一天,
    # 旧代码盘中直接丢K。UTC 主机盘中(UTC 1:30-7:00)本地日期与北京相同, 并不丢K;
    # UTC 的旧症状是北京 00:00-08:00 把昨日残留快照误当实时K注入。
    if not enriched_date or str(enriched_date)[:10] != today.isoformat():
        return None

    # 查找该 symbol 的实时 enriched 行
    import polars as pl
    try:
        q = df_today.filter(pl.col("symbol") == symbol).to_dicts()
        if not q:
            return None
        q = q[0]
    except Exception:
        return None

    close_price = q.get("close")
    if not close_price or close_price <= 0:
        return None

    # 沿用完整日K接口原有的实时行投影, 避免增量接口形成第二套字段契约。
    # API 在非交易时段可能返回 open/high/low=0, 用 close 填充避免异常蜡烛。
    raw_open = q.get("open")
    raw_high = q.get("high")
    raw_low = q.get("low")
    live_row = {
        "date": today.isoformat(),
        "symbol": symbol,
        "open": raw_open if raw_open and raw_open > 0 else close_price,
        "high": raw_high if raw_high and raw_high > 0 else close_price,
        "low": raw_low if raw_low and raw_low > 0 else close_price,
        "close": close_price,
        "volume": q.get("volume"),
        "amount": q.get("amount"),
        "change_pct": q.get("change_pct"),
        "is_live": True,
    }
    if q.get('quote_ts') is not None:
        live_row['quote_ts'] = q['quote_ts']
    if asset_type != "stock":
        live_row["turnover_rate"] = q.get("turnover_rate")
        for key in ("raw_close", "raw_high", "raw_low"):
            if q.get(key) is not None:
                live_row[key] = q[key]
    for key in ("ma5", "ma10", "ma20", "ma30", "ma60",
                "macd_dif", "macd_dea", "macd_hist",
                "kdj_k", "kdj_d", "kdj_j",
                "boll_upper", "boll_lower",
                "rsi_6", "rsi_14", "rsi_24",
                "atr_14", "vol_ratio_5d"):
        if key in q and q[key] is not None:
            live_row[key] = q[key]
    return live_row
