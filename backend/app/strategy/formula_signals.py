"""Formula-backed custom signals using the existing bounded formula interpreter."""
from __future__ import annotations

import logging
import math

import polars as pl

from app.indicators.chart_formula import compile_formula, evaluate

logger = logging.getLogger(__name__)
PERIODS = frozenset({'1d', '30m'})
_INPUT_COLUMNS = {'OPEN': 'open', 'O': 'open', 'HIGH': 'high', 'H': 'high',
                  'LOW': 'low', 'L': 'low', 'CLOSE': 'close', 'C': 'close',
                  'VOL': 'volume', 'VOLUME': 'volume', 'V': 'volume', 'AMOUNT': 'amount'}


def is_formula(signal: dict) -> bool:
    return signal.get('definition_type', 'conditions') == 'formula'


def validate_formula(formula: str, output_var: str | None = None) -> list[str]:
    program = compile_formula(formula)
    variables = [name for name, mode, *_ in program.statements if mode != 'draw']
    if output_var is not None and output_var not in variables:
        raise ValueError('输出变量必须是公式定义的变量')
    sample = [{'open': 10. + i * .01, 'high': 11. + i * .01, 'low': 9. + i * .01,
               'close': 10. + i * .01, 'volume': 1000., 'amount': 10000.} for i in range(100)]
    for period in PERIODS:
        evaluate(program, sample, period)
    return variables


def validate(signal: dict) -> None:
    if signal.get('timeframe', 'daily') != 'daily':
        raise ValueError('公式信号仅支持日线和30F K线, 不支持原始分钟信号')
    minimum = signal.get('min_history_bars', 100)
    if type(minimum) is not int or not 1 <= minimum <= 20000:
        raise ValueError('最低历史根数需要1~20000')
    if not isinstance(signal.get('formula'), str) or not isinstance(signal.get('output_var'), str):
        raise ValueError('公式和输出变量不能为空')
    validate_formula(signal['formula'], signal['output_var'])


def active(definitions: list[dict]) -> list[dict]:
    return [s for s in definitions if isinstance(s, dict) and isinstance(s.get('id'), str)
            and is_formula(s) and s.get('enabled') is not False]


def required_history(definitions: list[dict], needed: set[str] | None = None) -> int:
    required = 1
    for signal in active(definitions):
        if needed is not None and f"csg_{signal['id']}" not in needed:
            continue
        minimum = signal.get('min_history_bars', 100)
        if type(minimum) is not int or not 1 <= minimum <= 20000:
            minimum = 100
        # CROSS/REF must never run on a single current-day snapshot.
        required = max(required, minimum, 2)
    return required


def dependencies(definitions: list[dict]) -> dict[str, frozenset[str]]:
    result = {}
    for signal in active(definitions):
        roots = set()
        try:
            if not isinstance(signal.get('formula'), str):
                raise ValueError('公式必须是文本')
            for _, _, node, *_ in compile_formula(signal['formula']).statements:
                pending = [node]
                while pending:
                    value = pending.pop()
                    if not isinstance(value, tuple):
                        continue
                    if value and value[0] == 'name' and value[1] in _INPUT_COLUMNS:
                        roots.add(_INPUT_COLUMNS[value[1]])
                    pending.extend(part for part in value if isinstance(part, tuple))
        except (ValueError, KeyError) as exc:
            logger.warning('formula signal %s dependencies unavailable: %s', signal.get('id'), exc)
            continue
        result[f"csg_{signal['id']}"] = frozenset(roots)
    return result


def inject(df: pl.DataFrame, definitions: list[dict], needed: set[str] | None = None, *, period: str = '1d') -> pl.DataFrame:
    signals = [s for s in active(definitions) if needed is None or f"csg_{s['id']}" in needed]
    if df.is_empty() or not signals:
        return df
    if period not in PERIODS:
        if needed is not None:
            raise ValueError('公式信号仅支持日线和30F周期')
        return df.drop([f"csg_{s['id']}" for s in signals if f"csg_{s['id']}" in df.columns])
    timestamp = 'datetime' if 'datetime' in df.columns else 'date'
    groups = df.with_row_index('__formula_row').partition_by('symbol', maintain_order=True)
    for signal in signals:
        name = f"csg_{signal['id']}"
        try:
            if not isinstance(signal.get('formula'), str):
                raise ValueError('公式必须是文本')
            program = compile_formula(signal['formula'])
            minimum = signal.get('min_history_bars', 100)
            if type(minimum) is not int or not 1 <= minimum <= 20000:
                raise ValueError('最低历史根数需要1~20000')
            output = signal['output_var']
            required = dependencies([signal])[name]
            missing = required - set(df.columns)
            if missing:
                raise ValueError(f"缺少字段: {', '.join(sorted(missing))}")
            values: list[bool | None] = [None] * df.height
            for group in groups:
                group = group.sort(timestamp)
                rows = group.select([c for c in ('open', 'high', 'low', 'close', 'volume', 'amount') if c in group.columns]).to_dicts()
                computed = evaluate(program, rows, period)['rows']
                valid_count = 0
                for index, row, result in zip(group['__formula_row'], rows, computed, strict=True):
                    valid = all(row.get(c) is not None and math.isfinite(row[c]) for c in required)
                    valid_count = valid_count + 1 if valid else 0
                    value = result.get(output)
                    if output not in result:
                        raise ValueError('输出变量不存在')
                    if valid_count >= minimum and value is not None and math.isfinite(value):
                        values[index] = value != 0
            df = df.with_columns(pl.Series(name, values, dtype=pl.Boolean))
        except (ValueError, KeyError, TypeError, pl.exceptions.PolarsError) as exc:
            if needed is not None:
                raise ValueError(f"公式信号 {signal.get('name', name)} 无法计算: {exc}") from exc
            logger.warning('formula signal %s unavailable: %s', name, exc)
            if name in df.columns:
                df = df.drop(name)
    return df
