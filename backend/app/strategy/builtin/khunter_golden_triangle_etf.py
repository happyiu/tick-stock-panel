"""KHunter Golden Triangle ETF adaptation: ordered MA5/10/20 crosses."""

import numpy as np

from app.backtest.matrix import (
    MarketDataMatrix,
    SignalMatrix,
    make_signal_matrix,
    matrix_feature,
    valid_rolling_mean,
    valid_shift,
)

META = {
    "id": "khunter_golden_triangle_etf",
    "name": "ETF 金三角",
    "description": "MA5/10、MA5/20、MA10/20 依次金叉; 退出采用 MA20 跌破",
    "tags": ["ETF", "均线", "金叉"],
    "asset_types": ["etf"],
    "timeframes": ["1d"],
    "params": [
        {"id": "ac_interval", "label": "A 到 C 最多交易日", "type": "int", "default": 3, "min": 0, "max": 15, "step": 1},
        {"id": "min_change_pct", "label": "C 点最低涨幅%", "type": "float", "default": 0.5, "min": 0.0, "max": 10.0, "step": 0.1},
        {"id": "min_volume_ratio", "label": "C 点成交量/当日均量MA5", "type": "float", "default": 1.1, "min": 0.5, "max": 5.0, "step": 0.1},
        {"id": "require_ma60_rising", "label": "要求 MA60 上行", "type": "bool", "default": True},
    ],
    "scoring": {"momentum_20d": 0.5, "vol_ratio_5d": 0.5},
    "order_by": "score",
    "descending": True,
    "limit": 100,
}

EXECUTION_BACKEND = "matrix_native"
ENTRY_SIGNALS = ["signal_khunter_golden_triangle_etf"]
EXIT_SIGNALS = ["signal_khunter_golden_triangle_ma20_exit"]


class KHunterGoldenTriangleETFMatrixStrategy:
    def required_fields(self) -> frozenset[str]:
        return frozenset({"close", "volume"})

    def required_warmup_bars(self, params: dict) -> int:
        return 61 + max(0, int(params.get("ac_interval", 3)))

    def compute_signals(self, market: MarketDataMatrix, params: dict) -> SignalMatrix:
        ma5 = matrix_feature(market, "ma5")
        ma10 = matrix_feature(market, "ma10")
        ma20 = matrix_feature(market, "ma20")
        ma60 = matrix_feature(market, "ma60")
        prev5 = valid_shift(ma5, 1)
        prev10 = valid_shift(ma10, 1)
        prev20 = valid_shift(ma20, 1)
        a_cross = (ma5 >= ma10) & (prev5 < prev10)
        b_cross = (ma5 >= ma20) & (prev5 < prev20)
        c_cross = (ma10 >= ma20) & (prev10 < prev20)

        # A and B may share a day; A must be no later than B, and C is today.
        interval = max(0, int(params.get("ac_interval", 3)))
        ordered = np.zeros(market.shape, dtype=bool)
        valid = np.isfinite(market.close)
        a_seen = np.zeros(market.shape, dtype=bool)
        for b_age in range(interval, -1, -1):
            b_recent = valid_shift(b_cross.astype(np.float32), b_age, valid) == 1
            a_seen |= valid_shift(a_cross.astype(np.float32), b_age, valid) == 1
            ordered |= b_recent & a_seen

        prev_close = valid_shift(market.close, 1)
        gain = np.divide(
            market.close - prev_close,
            prev_close,
            out=np.full(market.shape, np.nan, dtype=np.float32),
            where=prev_close > 0,
        )
        vol_ma5 = valid_rolling_mean(
            market.volume, valid & np.isfinite(market.volume), 5
        )
        vol_ratio = np.divide(
            market.volume,
            vol_ma5,
            out=np.full(market.shape, np.nan, dtype=np.float32),
            where=vol_ma5 > 0,
        )
        entry = (
            c_cross
            & ordered
            & (ma5 >= ma10)
            & (ma10 >= ma20)
            & (ma20 >= ma60)
            & (gain >= float(params.get("min_change_pct", 0.5)) / 100.0)
            & (vol_ratio >= float(params.get("min_volume_ratio", 1.1)))
        )
        if params.get("require_ma60_rising", True):
            entry &= ma60 > valid_shift(ma60, 1)
        exit_ = (market.close < ma20) & (prev_close >= valid_shift(ma20, 1))
        return make_signal_matrix(
            market.shape,
            entry=entry.astype(np.uint8),
            exit=exit_.astype(np.uint8),
            entry_signal_code=np.where(entry, 0, -1).astype(np.int16),
            exit_signal_code=np.where(exit_, 0, -1).astype(np.int16),
            entry_signal_ids=("signal_khunter_golden_triangle_etf",),
            exit_signal_ids=("signal_khunter_golden_triangle_ma20_exit",),
        )


MATRIX_STRATEGY = KHunterGoldenTriangleETFMatrixStrategy()
