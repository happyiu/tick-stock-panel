"""K 线展示周期聚合。

周/月 K 基于前复权日线聚合，30 分钟 K 基于北京时间墙钟的 1 分钟 K 聚合。
本模块只负责单标的 OHLCV 与图表指标，不改变持久化数据。
"""
# ruff: noqa: RUF002, RUF003

from __future__ import annotations

import polars as pl

from app.indicators.pipeline import compute_indicators

CHART_INDICATORS = {
    "ma5", "ma10", "ma20", "ma60",
    "macd_dif", "macd_dea", "macd_hist",
    "rsi_6", "rsi_14", "rsi_24",
    "kdj_k", "kdj_d", "kdj_j",
    "boll_upper", "boll_lower",
}


def _with_chart_indicators(df: pl.DataFrame) -> pl.DataFrame:
    if df.is_empty():
        return df
    return compute_indicators(df, needed=CHART_INDICATORS)


def prepare_native_30m(df: pl.DataFrame) -> pl.DataFrame:
    """原生30分钟K只转换展示字段并算指标，不再次聚合成交量。"""
    return _with_chart_indicators(df.with_columns(
        pl.col("datetime").dt.strftime("%Y-%m-%d %H:%M").alias("date"),
        (pl.col("datetime") - pl.duration(minutes=30)).alias("period_start"),
        pl.col("datetime").alias("period_end"),
    ).sort(["symbol", "datetime"]))


def aggregate_daily_period(df: pl.DataFrame, period: str) -> pl.DataFrame:
    """把单标的日线聚合为周 K 或月 K，并按聚合周期重算图表指标。"""
    if df.is_empty():
        return df
    if period not in {"1w", "1mo"}:
        raise ValueError(f"unsupported daily period: {period}")

    frame = df.with_columns(pl.col("date").cast(pl.Date, strict=False)).drop_nulls("date")
    if frame.is_empty():
        return frame
    frame = frame.sort(["symbol", "date"])
    bucket = pl.col("date").dt.truncate("1w" if period == "1w" else "1mo")
    expressions: list[pl.Expr] = [
        pl.col("date").min().alias("period_start"),
        pl.col("date").max().alias("period_end"),
        pl.col("open").first().alias("open"),
        pl.col("high").max().alias("high"),
        pl.col("low").min().alias("low"),
        pl.col("close").last().alias("close"),
    ]
    for column in ("volume", "amount"):
        if column in frame.columns:
            expressions.append(pl.col(column).fill_null(0).sum().alias(column))

    aggregated = (
        frame.with_columns(bucket.alias("_period"))
        .group_by(["symbol", "_period"], maintain_order=True)
        .agg(expressions)
        .with_columns(pl.col("period_end").alias("date"))
        .drop("_period")
        .sort(["symbol", "date"])
    )
    return _with_chart_indicators(aggregated)


def aggregate_minute_30m(df: pl.DataFrame) -> pl.DataFrame:
    """按 A 股上午/下午两个交易时段聚合 30 分钟 K。

    兼容分钟时间戳以 09:30/13:00（区间起点）或 09:31/13:01（区间终点）
    起始的来源；11:30 和 15:00 均归入各自最后一个桶。
    """
    if df.is_empty() or "datetime" not in df.columns:
        return pl.DataFrame()

    frame = df.with_columns(
        pl.col("datetime").cast(pl.Datetime("us"), strict=False),
    ).drop_nulls("datetime")
    if frame.is_empty():
        return frame

    clock_minute = (
        pl.col("datetime").dt.hour().cast(pl.Int32) * 60
        + pl.col("datetime").dt.minute().cast(pl.Int32)
    )
    in_morning = clock_minute.is_between(9 * 60 + 30, 11 * 60 + 30, closed="both")
    in_afternoon = clock_minute.is_between(13 * 60, 15 * 60, closed="both")
    # 09:31~10:00 为第一桶；若来源含 09:30，则同样并入第一桶。
    morning_index = ((clock_minute - (9 * 60 + 31)).clip(lower_bound=0) // 30).clip(upper_bound=3)
    afternoon_index = 4 + ((clock_minute - (13 * 60 + 1)).clip(lower_bound=0) // 30).clip(upper_bound=3)
    frame = (
        frame.filter(in_morning | in_afternoon)
        .with_columns(
            pl.col("datetime").dt.date().alias("_trade_date"),
            pl.when(in_morning).then(morning_index).otherwise(afternoon_index).alias("_bucket"),
        )
        .sort(["symbol", "datetime"])
    )
    if frame.is_empty():
        return frame

    expressions: list[pl.Expr] = [
        pl.col("datetime").min().alias("period_start"),
        pl.col("datetime").max().alias("period_end"),
        pl.col("open").drop_nulls().first().alias("_open"),
        pl.col("close").first().alias("_first_close"),
        pl.col("high").max().alias("high"),
        pl.col("low").min().alias("low"),
        pl.col("close").last().alias("close"),
    ]
    for column in ("volume", "amount"):
        if column in frame.columns:
            expressions.append(pl.col(column).fill_null(0).sum().alias(column))

    bucket_labels = {
        0: "10:00", 1: "10:30", 2: "11:00", 3: "11:30",
        4: "13:30", 5: "14:00", 6: "14:30", 7: "15:00",
    }
    label = pl.concat_str([
        pl.col("_trade_date").cast(pl.String),
        pl.lit(" "),
        pl.col("_bucket").replace_strict(bucket_labels, return_dtype=pl.String),
    ])
    aggregated = (
        frame.group_by(["symbol", "_trade_date", "_bucket"], maintain_order=True)
        .agg(expressions)
        .with_columns(
            pl.coalesce([pl.col("_open"), pl.col("_first_close")]).alias("open"),
            label.alias("date"),
        )
        .drop(["_trade_date", "_bucket", "_open", "_first_close"])
        .sort(["symbol", "date"])
    )
    return _with_chart_indicators(aggregated)
