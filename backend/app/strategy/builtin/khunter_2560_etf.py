"""KHunter 2560 ETF adaptation: MA25 price cross and volume MA5/60 cross."""

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
    "id": "khunter_2560_etf",
    "name": "ETF 2560 战法",
    "description": "MA25 与均量 MA5/60 同日金叉; 涨幅默认 2% 为 ETF 待验证参数, 退出采用 MA10 跌破",
    "tags": ["ETF", "均线", "量价"],
    "asset_types": ["etf"],
    "timeframes": ["1d"],
    "params": [
        {"id": "min_change_pct", "label": "信号日最低涨幅%", "type": "float", "default": 2.0, "min": 0.0, "max": 10.0, "step": 0.5},
        {"id": "min_volume_ratio", "label": "成交量/当日均量MA5", "type": "float", "default": 1.5, "min": 0.5, "max": 5.0, "step": 0.1},
    ],
    "scoring": {"momentum_20d": 0.5, "vol_ratio_5d": 0.5},
    "order_by": "score",
    "descending": True,
    "limit": 100,
}

EXECUTION_BACKEND = "matrix_native"
ENTRY_SIGNALS = ["signal_khunter_2560_etf"]
EXIT_SIGNALS = ["signal_khunter_2560_ma10_exit"]


class KHunter2560ETFMatrixStrategy:
    def required_fields(self) -> frozenset[str]:
        return frozenset({"close", "volume"})

    def required_warmup_bars(self, params: dict) -> int:
        del params
        return 61

    def compute_signals(self, market: MarketDataMatrix, params: dict) -> SignalMatrix:
        valid = np.isfinite(market.close) & np.isfinite(market.volume)
        ma10 = matrix_feature(market, "ma10")
        ma25 = matrix_feature(market, "ma25")
        vol_ma5 = valid_rolling_mean(market.volume, valid, 5)
        vol_ma60 = valid_rolling_mean(market.volume, valid, 60)
        prev_close = valid_shift(market.close, 1)

        price_cross = (market.close > ma25) & (prev_close <= valid_shift(ma25, 1))
        volume_cross = (vol_ma5 > vol_ma60) & (
            valid_shift(vol_ma5, 1) <= valid_shift(vol_ma60, 1)
        )
        gain = np.divide(
            market.close - prev_close,
            prev_close,
            out=np.full(market.shape, np.nan, dtype=np.float32),
            where=prev_close > 0,
        )
        ratio = np.divide(
            market.volume,
            vol_ma5,
            out=np.full(market.shape, np.nan, dtype=np.float32),
            where=vol_ma5 > 0,
        )
        entry = (
            price_cross
            & volume_cross
            & (market.close > ma10)
            & (gain >= float(params.get("min_change_pct", 2.0)) / 100.0)
            & (ratio >= float(params.get("min_volume_ratio", 1.5)))
        )
        exit_ = (market.close < ma10) & (prev_close >= valid_shift(ma10, 1))
        return make_signal_matrix(
            market.shape,
            entry=entry.astype(np.uint8),
            exit=exit_.astype(np.uint8),
            entry_signal_code=np.where(entry, 0, -1).astype(np.int16),
            exit_signal_code=np.where(exit_, 0, -1).astype(np.int16),
            entry_signal_ids=("signal_khunter_2560_etf",),
            exit_signal_ids=("signal_khunter_2560_ma10_exit",),
        )


MATRIX_STRATEGY = KHunter2560ETFMatrixStrategy()
