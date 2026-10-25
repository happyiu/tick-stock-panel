# ruff: noqa: RUF001
"""Chart indicator catalog and atomic user overrides; independent of strategy indicators."""
from __future__ import annotations

import copy
import hashlib
import json
import re
import threading
import uuid
from functools import lru_cache
from pathlib import Path

from app.indicators.chart_formula import FormulaError, compile_formula, evaluate
from app.services.fs_utils import atomic_write_text

DEFAULTS = Path(__file__).with_name('chart_defaults')
ID_RE = re.compile(r'^[a-z][a-z0-9-]{0,63}$')
_LOCK = threading.RLock()


class CatalogError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


@lru_cache(maxsize=1)
def defaults():
    return {item['id']: item for file in sorted(DEFAULTS.glob('*.json'))
            for item in [json.loads(file.read_text(encoding='utf-8'))]}


def _directory(data_dir):
    directory = Path(data_dir) / 'user_data' / 'custom_indicators'
    if directory.is_symlink() or directory.parent.is_symlink():
        raise CatalogError('指标目录不能使用符号链接')
    return directory


def _path(data_dir, key):
    if not ID_RE.fullmatch(key):
        raise CatalogError('指标ID格式非法')
    if key.startswith('builtin-'):
        raise CatalogError('内置指标不允许修改或删除', 403)
    target = _directory(data_dir) / f'{key}.json'
    if target.is_symlink():
        raise CatalogError('指标文件不能使用符号链接')
    return target


@lru_cache(maxsize=128)
def _load_override(path, mtime_ns, size):
    item = json.loads(Path(path).read_text(encoding='utf-8'))
    if not isinstance(item, dict):
        raise ValueError('指标文件必须是对象')
    if type(item.get('revision')) is not int or item['revision'] < 1:
        raise ValueError('指标版本非法')
    if not item.get('deleted'):
        if item.get('source') != 'custom' or not isinstance(item.get('height'), (int, float)) or not 50 <= item['height'] <= 2000:
            raise ValueError('指标来源或高度非法')
        validate_definition(item)
    return item


def list_indicators(data_dir):
    items = copy.deepcopy(defaults())
    errors = []
    directory = _directory(data_dir)
    if directory.exists():
        for file in sorted(directory.glob('*.json')):
            key = file.stem
            try:
                _path(data_dir, key)
                stat = file.stat()
                item = copy.deepcopy(_load_override(str(file), stat.st_mtime_ns, stat.st_size))
                if item['id'] != key:
                    raise ValueError('指标ID与文件不一致')
                if item.get('deleted'):
                    items.pop(key, None)
                else:
                    items[key] = item
            except (ValueError, OSError, KeyError) as exc:
                items.pop(key, None)
                errors.append({'id': key, 'message': f'指标加载失败：{exc}'})
    return {'items': list(items.values()), 'errors': errors}


def get_indicator(data_dir, key):
    _path(data_dir, key)
    result = list_indicators(data_dir)
    for item in result['items']:
        if item['id'] == key:
            return item
    if any(e['id'] == key for e in result['errors']):
        raise CatalogError('指标文件损坏，请修复后重试', 409)
    raise CatalogError('指标不存在或已删除', 404)


def validate_definition(item):
    if not isinstance(item.get('name'), str) or not 1 <= len(item['name'].strip()) <= 80:
        raise CatalogError('名称需要1～80个字符', 422)
    if item.get('pane') not in ('main', 'sub'):
        raise CatalogError('指标类型必须为主图叠加或副图', 422)
    if not isinstance(item.get('description', ''), str) or len(item.get('description', '')) > 2000:
        raise CatalogError('说明最多2000个字符', 422)
    formula = item.get('formula', '')
    if not isinstance(formula, str):
        raise CatalogError('公式必须是文本', 422)
    program = compile_formula(formula)
    if item['pane'] != 'main' and any(node[0] == 'call' and node[1] == 'DRAWPIVOT'
                                    for _, mode, node, *_ in program.statements if mode == 'draw'):
        raise CatalogError('DRAWPIVOT仅支持主图叠加指标', 422)
    variables = formula_variables(program)
    signals = item.get('monitor_signals', [])
    if not isinstance(signals, list) or len(signals) > 32:
        raise CatalogError('最多配置32个监控信号', 422)
    seen = set()
    for signal in signals:
        if not isinstance(signal, dict) or not ID_RE.fullmatch(str(signal.get('id', ''))):
            raise CatalogError('监控信号ID格式非法', 422)
        if signal['id'] in seen:
            raise CatalogError('监控信号ID不能重复', 422)
        seen.add(signal['id'])
        if not isinstance(signal.get('name'), str) or not 1 <= len(signal['name'].strip()) <= 80:
            raise CatalogError('信号名称需要1～80个字符', 422)
        if signal.get('variable') not in variables:
            raise CatalogError('监控条件变量必须由公式定义', 422)
        periods = signal.get('periods')
        if not isinstance(periods, list) or not periods or any(p not in ('30m', '1d') for p in periods):
            raise CatalogError('信号周期仅支持30f和日线', 422)
    minimum = item.get('min_history_bars', 100)
    if type(minimum) is not int or not 1 <= minimum <= 20000:
        raise CatalogError('最低历史根数需要1～20000', 422)
    # Run all branches on a small frame to validate period parameters and argument types.
    sample = [{'open': 10+i*.01, 'close': 10+i*.02, 'high': 11+i*.02,
               'low': 9+i*.01, 'volume': 1000+i, 'amount': 10000+i} for i in range(90)]
    for period in ('1d', '30m', '1w', '1mo'):
        evaluate(program, sample, period)
    return program


def formula_variables(program):
    return [key for key, mode, *_ in program.statements if mode != 'draw']


def calculation_fingerprint(item):
    value = {key: item.get(key, default) for key, default in (
        ('formula', ''), ('monitor_signals', []), ('min_history_bars', 100))}
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def save_indicator(data_dir, payload, key=None):
    with _LOCK:
        if key is None:
            key = f'user-{uuid.uuid4().hex}'
            revision = 1
            base = get_indicator(data_dir, payload['copy_from']) if payload.get('copy_from') else {}
            if base:
                base = {**base, 'calculation_origin': base.get('calculation_origin', base['id'])}
        else:
            base = get_indicator(data_dir, key)
            if payload.get('revision') != base['revision']:
                raise CatalogError('指标已被修改，请重新打开后再保存', 409)
            revision = base['revision'] + 1
        item = {**base, 'id': key, 'source': 'custom', 'name': payload['name'].strip(),
                'pane': payload['pane'], 'description': payload.get('description', ''),
                'formula': payload['formula'], 'revision': revision, 'height': base.get('height', 120)}
        item['monitor_signals'] = payload.get('monitor_signals', base.get('monitor_signals', []))
        item['min_history_bars'] = payload.get('min_history_bars', base.get('min_history_bars', 100))
        validate_definition(item)
        target = _path(data_dir, key)
        target.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(target, json.dumps(item, ensure_ascii=False, indent=2))
        return item


def delete_indicator(data_dir, key, revision):
    with _LOCK:
        item = get_indicator(data_dir, key)
        if revision != item['revision']:
            raise CatalogError('指标已被修改，请刷新后再删除', 409)
        target = _path(data_dir, key)
        target.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(target, json.dumps({'id': key, 'deleted': True, 'revision': revision+1}))



def _evaluate_for_chart(formula, rows, period, compare_days):
    computed = evaluate(compile_formula(formula), rows, period, compare_days)
    values = computed['rows']
    # Keep explicit outputs and the existing candle/status/volume display contracts.
    fields = {f['key'] for f in computed['figures']}
    fields.update(k for k in ('bull', 'supported', 'ready', 'volValue', 'mid') if values and k in values[0])
    columns = {tuple(row[key] for row in values): key for key in sorted(fields)}
    drawings = []
    for drawing in computed['drawings']:
        if 'levels' in drawing:
            drawing = {**drawing, 'levels': [
                {'value': level['value'],
                 'pivot_date': str(rows[level['pivot_index']]['date']).replace('T', ' ')[:16 if period == '30m' else 10],
                 'confirmed_date': str(rows[level['confirmed_index']]['date']).replace('T', ' ')[:16 if period == '30m' else 10]}
                for level in drawing['levels']
            ]}
        mapped, constants = [], []
        for position, key in drawing['fields']:
            column = tuple(row[key] for row in values)
            if column and all(value == column[0] for value in column):
                constants.append([position, column[0]])
            else:
                canonical = columns.setdefault(column, key)
                fields.add(canonical)
                mapped.append([position, canonical])
        drawings.append({**drawing, 'fields': mapped, 'constants': constants})
    return {**computed, 'rows': [{key: row[key] for key in sorted(fields)} for row in values], 'drawings': drawings}


@lru_cache(maxsize=8)
def _cached_evaluation(formula, snapshot, period, compare_days, context):
    return _evaluate_for_chart(formula, json.loads(snapshot), period, compare_days)


def attach_results(payload, data_dir, ids, compare_days=1, history_rows=None):
    """Compute before viewport clipping; retain the six legacy formulas' loaded-series origin."""
    if not isinstance(ids, str) or not ids.strip():
        return payload
    keys = list(dict.fromkeys(k.strip() for k in ids.split(',') if k.strip()))
    if len(keys) > 32:
        raise FormulaError('一次最多32个指标')
    period = payload.get('period', '1d')
    rows = payload.get('rows', [])
    history = history_rows or rows
    # Real-time candle replacement must be identical to the candle returned to the client.
    by_date = {str(r['date']).replace('T', ' '): r for r in history}
    by_date.update({str(r['date']).replace('T', ' '): r for r in rows})
    cutoff = max((str(r['date']).replace('T', ' ') for r in rows), default='')
    history = [by_date[key] for key in sorted(by_date) if key <= cutoff]
    catalog = {item['id']: item for item in list_indicators(data_dir)['items']}
    legacy_loaded = {'angel-devil', 'boll2', 'kd-divergence', 'kd-enhanced', 'etf-swing-v2', 'bull-bear-trend-v2', 'vol'}
    result, errors, snapshots = {}, [], {}
    for key in keys:
        item = catalog.get(key)
        if not item:
            errors.append({'id': key, 'message': '指标已删除或加载失败'})
            continue
        try:
            origin = item.get('calculation_origin', key)
            input_rows = rows if origin in legacy_loaded else history
            # Enriched scores and other unrelated columns are not formula inputs.
            if id(input_rows) not in snapshots:
                snapshots[id(input_rows)] = json.dumps([
                    {field: row.get(field) for field in ('date', 'open', 'high', 'low', 'close', 'volume', 'amount', 'is_closed')
                     if field != 'is_closed' or field in row}
                    for row in input_rows
                ], default=str, allow_nan=True, separators=(',', ':'))
            snapshot = snapshots[id(input_rows)]
            context = (str(data_dir), payload.get('symbol'), payload.get('asset_type'), key, item['revision'])
            if len(input_rows) <= 2000 and len(input_rows) * len(compile_formula(item['formula']).statements) <= 200000:
                computed = copy.deepcopy(_cached_evaluation(item['formula'], snapshot, period, compare_days, context))
            else:
                computed = _evaluate_for_chart(item['formula'], input_rows, period, compare_days)
            if input_rows is not rows:
                index = {str(r['date']).replace('T', ' '): i for i, r in enumerate(input_rows)}
                computed['rows'] = [computed['rows'][index[str(r['date']).replace('T', ' ')]] for r in rows]
            # Unmodified base formulas equal pipeline expressions: reuse its already warmed columns.
            if origin in {'ma', 'macd', 'rsi', 'kdj', 'boll'} and item['formula'] == defaults()[origin]['formula']:
                for original, projected in zip(rows, computed['rows'], strict=True):
                    for field in list(projected):
                        if field in original:
                            projected[field] = original[field]
            computed['dates'] = [str(r['date']).replace('T', ' ')[:16 if period == '30m' else 10] for r in rows]
            result[key] = {**computed, 'revision': item['revision'], 'name': item['name'],
                           'pane': item['pane'], 'min_value': item.get('min_value'), 'max_value': item.get('max_value'), 'precision': item.get('precision')}
        except FormulaError as exc:
            errors.append({'id': key, 'message': str(exc)})
    return {**payload, 'indicator_results': result, 'indicator_errors': errors}
