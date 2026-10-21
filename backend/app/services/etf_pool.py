"""Read-only ETF catalog over the repository's current instrument snapshot."""
from typing import Literal

import polars as pl

EtfCategory = Literal["跨境", "债券", "商品", "货币", "宽基", "策略风格", "行业主题", "其他"]

# 名称规则分类, 不代表基金官方投资范围; 无法识别的名称保留为「其他」。
_CATEGORY_RULES = (
    ("跨境", "港|恒生|中概|纳指|纳斯达克|标普|日经|德国|法国|日本|美国|欧洲|亚太|沙特|东南亚|全球|海外|道琼斯|韩国|巴西"),
    ("债券", "债|信用|城投|政金"),
    ("商品", "黄金|白银|原油|豆粕|有色期货|商品|能源化工期货"),
    ("货币", "货币|现金|添益|快线|日利|保证金"),
    ("策略风格", "红利|低波|价值|成长|质量|基本面|等权|ESG|自由现金流"),
    ("宽基", "沪深300|中证(50|100|200|300|500|800|1000|2000|A50|A100|A500)|上证(50|180|380)|科创(50|100|200)|创业板(50|100|200|ETF|综)|深证(50|100)|深100|深成|全指ETF|综指"),
    ("行业主题", "黄金股|黄金产业|稀有金属|算力|卫星|粮食|半导体|芯片|医药|医疗|生物|创新药|消费|酒|食品|饮料|家电|汽车|新能源|光伏|电池|电力|能源|煤炭|石油|化工|有色|稀土|钢铁|金融|银行|证券|券商|保险|地产|房地产|基建|建材|工程|机械|军工|国防|航天|航空|科技|信息|计算机|软件|通信|5G|人工智能|智能|机器人|传媒|游戏|互联网|云计算|数据|数字|电子|农业|养殖|畜牧|环保|碳中和|物流|运输|交通|旅游|教育|科创芯片"),
)


def list_etfs(repo, *, q: str = "", category: str = "", exchange: str = "", page: int = 1, page_size: int = 20) -> dict:
    source = repo.get_etf_instruments()
    df = pl.DataFrame(schema={"symbol": pl.String, "name": pl.String})
    if not source.is_empty() and "symbol" in source.columns:
        df = source.select(
            pl.col("symbol").cast(pl.String),
            (pl.col("name").cast(pl.String).fill_null("") if "name" in source.columns else pl.lit("")).alias("name"),
        ).filter(pl.col("symbol").is_not_null() & (pl.col("symbol") != "")).unique(subset="symbol", keep="last")
    classification = pl.when(pl.lit(False)).then(pl.lit("其他"))
    for label, pattern in _CATEGORY_RULES:
        match = pl.col("name").str.to_uppercase().str.contains(pattern)
        if label == "商品":
            match = match & ~pl.col("name").str.contains("黄金股|黄金产业")
        classification = classification.when(match).then(pl.lit(label))
    df = df.with_columns(
        pl.col("symbol").str.split(".").list.first().alias("code"),
        pl.col("symbol").str.split(".").list.last().alias("exchange"),
        classification.otherwise(pl.lit("其他")).alias("category"),
    )
    counts = dict(df.group_by("category").len().iter_rows())
    categories = [{"name": label, "count": counts.get(label, 0)} for label in (*[r[0] for r in _CATEGORY_RULES], "其他")]
    catalog_total = df.height
    keyword = q.strip().upper()
    if keyword:
        df = df.filter(pl.col("symbol").str.to_uppercase().str.contains(keyword, literal=True)
                       | pl.col("name").str.to_uppercase().str.contains(keyword, literal=True))
    if category:
        df = df.filter(pl.col("category") == category)
    if exchange:
        df = df.filter(pl.col("exchange") == exchange)
    page_df = df.sort("symbol").slice(min((page - 1) * page_size, df.height), page_size)
    if not page_df.is_empty():
        quotes = repo.get_etf_quote_snapshot(page_df["symbol"].to_list())
        if not quotes.is_empty():
            page_df = page_df.join(quotes, on="symbol", how="left")
    for column, dtype in (("last_price", pl.Float64), ("change_pct", pl.Float64), ("quote_date", pl.String)):
        if column not in page_df.columns:
            page_df = page_df.with_columns(pl.lit(None, dtype=dtype).alias(column))
    return {
        "rows": page_df.to_dicts(),
        "total": df.height, "catalog_total": catalog_total, "categories": categories,
        "page": page, "page_size": page_size,
    }
