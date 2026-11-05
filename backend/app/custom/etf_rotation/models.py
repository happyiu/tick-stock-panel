# ruff: noqa: RUF001
"""Validated, per-run ETF rotation configuration. Rates are decimal fractions."""

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

VERSION = "rotation-v2"
SOURCE_REVISION = "586bf3737261866337952fc0ead53b1f77081be0"
BROAD = ["510050.SH", "510300.SH", "510500.SH", "512100.SH", "563000.SH", "159915.SZ", "588000.SH"]
CROSS = ["510300.SH", "510500.SH", "513100.SH", "513500.SH", "159920.SZ"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Parameters(StrictModel):
    market_ma_period: int = Field(60, ge=20, le=252)
    market_band: float = Field(0.02, gt=0, le=0.2)
    bull_exposure: float = Field(1, ge=0, le=1)
    neutral_exposure: float = Field(0.5, ge=0, le=1)
    bear_exposure: float = Field(0, ge=0, le=1)
    min_hold: int = Field(10, ge=1, le=252)
    adjustment_days: int = Field(3, ge=1, le=30)
    momentum_window: int = Field(20, ge=2, le=252)
    switch_gap: float = Field(0.03, ge=0, le=1)
    switch_std: float = Field(0.5, ge=0, le=10)
    trend_weight: float = Field(0.25, ge=0, le=1)
    sharpe_weight: float = Field(0.25, ge=0, le=1)
    quality_weight: float = Field(0.25, ge=0, le=1)
    volume_weight: float = Field(0.25, ge=0, le=1)
    short_confirmation: bool = False
    bull_filter: bool = True
    panic_drop: float = Field(-0.02, ge=-1, lt=0)
    panic_vol: float = Field(1.3, gt=0, le=10)
    panic_breadth: float = Field(0.6, ge=0, le=1)
    gold_min_hold: int = Field(5, ge=1, le=252)
    gold_max_hold: int = Field(20, ge=1, le=252)
    gold_stop: float = Field(-0.05, ge=-1, lt=0)
    panic_exit: float = Field(-0.01, ge=-1, le=1)
    risk_mode: Literal["A", "B", "C"] = "B"
    account_guard: bool = True
    max_drawdown: float = Field(0.15, gt=0, le=1)
    take_profit: float = Field(0.10, gt=0, le=10)
    trailing_drawdown: float = Field(0.05, gt=0, le=1)
    atr_multiple: float = Field(4, gt=0, le=20)

    @model_validator(mode="after")
    def coherent(self):
        if not self.bear_exposure <= self.neutral_exposure <= self.bull_exposure:
            raise ValueError("仓位上限必须满足熊市≤震荡≤牛市")
        if (
            abs(
                self.trend_weight
                + self.sharpe_weight
                + self.quality_weight
                + self.volume_weight
                - 1
            )
            > 1e-8
        ):
            raise ValueError("四项因子权重之和必须等于1")
        if self.gold_min_hold > self.gold_max_hold:
            raise ValueError("避险最小持有期不能大于最大持有期")
        return self


class Fees(StrictModel):
    commission: float = Field(0.0002, ge=0, le=0.05)
    slippage: float = Field(0.0001, ge=0, le=0.05)
    minimum: float = Field(0, ge=0, le=1000)


class RotationConfig(StrictModel):
    name: str = Field(min_length=1, max_length=80)
    strategy: Literal[
        "composite_momentum", "gold_safe_haven", "cross_border", "composite_momentum_enhanced"
    ]
    symbols: list[str] = Field(min_length=2, max_length=100)
    haven_symbol: str = "518880.SH"
    reference_symbol: str = "510300.SH"
    parameters: Parameters = Field(default_factory=Parameters)
    fees: Fees = Field(default_factory=Fees)

    @model_validator(mode="after")
    def validate_pool(self):
        self.name = self.name.strip()
        if not self.name:
            raise ValueError("配置名称不能为空")
        self.symbols = list(dict.fromkeys(self.symbols))
        if len(self.symbols) < 2:
            raise ValueError("候选池至少需要两只不同ETF")
        import re

        for symbol in [*self.symbols, self.haven_symbol, self.reference_symbol]:
            if not re.fullmatch(r"\d{6}\.(SH|SZ)", symbol):
                raise ValueError("ETF代码必须为标准证券代码，例如510300.SH")
        if self.strategy == "gold_safe_haven" and self.haven_symbol in self.symbols:
            raise ValueError("避险ETF不能加入正常轮动池")
        if self.strategy == "gold_safe_haven" and self.parameters.adjustment_days != 1:
            raise ValueError("黄金避险采用一次切换，调仓天数必须为1")
        return self


class RunRequest(StrictModel):
    config: RotationConfig
    start: date
    end: date
    initial_cash: float = Field(10000, ge=100, le=1e10)

    @model_validator(mode="after")
    def dates(self):
        if self.end < self.start or (self.end - self.start).days > 7305:
            raise ValueError("回测区间无效，最长20年")
        return self


class PreviewRequest(StrictModel):
    config: RotationConfig
    backtest_id: str | None = None


def templates():
    result = []
    for strategy, name in [
        ("composite_momentum", "复合动量"),
        ("gold_safe_haven", "黄金避险"),
        ("cross_border", "跨境轮动"),
        ("composite_momentum_enhanced", "复合动量·环境增强"),
    ]:
        p = Parameters()
        if strategy == "cross_border":
            p.momentum_window, p.switch_gap, p.adjustment_days = 10, 0.02, 5
        if strategy == "gold_safe_haven":
            p.adjustment_days, p.risk_mode, p.short_confirmation = 1, "A", True
        config = RotationConfig(
            name=name,
            strategy=strategy,
            symbols=CROSS if strategy == "cross_border" else BROAD,
            parameters=p,
        )
        result.append(config.model_dump())
    return result
