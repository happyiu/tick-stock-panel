# ruff: noqa: RUF001
"""Bounded, causal chart-only formula interpreter. No executable user code."""
from __future__ import annotations

import heapq
import math
import operator
import re
import time
from dataclasses import dataclass
from functools import lru_cache

import polars as pl

NAN = float('nan')
COLORS = {'RED': '#FF0000', 'GREEN': '#00FF00', 'YELLOW': '#FFFF00',
          'WHITE': '#FFFFFF', 'CYAN': '#00FFFF', 'MAGENTA': '#FF00FF',
          'BLUE': '#3B82F6', 'GRAY': '#808080', 'PINK': '#CC66FF', 'OLIVE': '#669900'}
FUNCTIONS = {'MA': (2, 2), 'EMA': (2, 3), 'SMA': (3, 4), 'REF': (2, 2),
             'HHV': (2, 2), 'LLV': (2, 2), 'SUM': (2, 2), 'COUNT': (2, 2),
             'STD': (2, 2), 'ABS': (1, 1), 'SQRT': (1, 1), 'MAX': (2, 2),
             'MIN': (2, 2), 'IF': (3, 3), 'CROSS': (2, 2), 'BARSLAST': (1, 1),
             'FILTER': (2, 2), 'SLOPE': (2, 2), 'VALUEWHEN': (2, 2),
             'BARSCOUNT': (1, 1), 'ISVALID': (1, 1), 'NZ': (1, 2), 'SIGN': (1, 1)}
DRAWINGS = {'STICKLINE': (5, 5), 'DRAWTEXT': (3, 4), 'DRAWICON': (3, 4),
            'DRAWSEGMENT': (3, 3), 'DRAWLINE': (5, 5), 'HLINE': (1, 2), 'TOOLTIP': (2, 4),
            'DRAWPIVOT': (4, 4)}
MAX_PIVOT_LEVELS = 500
INPUTS = {'OPEN', 'HIGH', 'LOW', 'CLOSE', 'O', 'H', 'L', 'C', 'VOL', 'VOLUME',
          'V', 'AMOUNT', 'PERIOD', 'COMPARE_DAYS', 'DRAWNULL', 'TRUE', 'FALSE'}
TOKEN = re.compile(r"\s+|\{[^}]*\}|//[^\n]*|(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?|'(?:[^'\\]|\\.)*'|[\w\u4e00-\u9fff]+|:=|>=|<=|<>|!=|==|&&|\|\||[+*/^=<>():;,!\-]", re.DOTALL)
BINARY = {'OR': 1, '||': 1, 'AND': 2, '&&': 2, '=': 3, '==': 3, '!=': 3, '<>': 3,
          '>': 3, '<': 3, '>=': 3, '<=': 3, '+': 4, '-': 4, '*': 5, '/': 5, '^': 6}


class FormulaError(ValueError):
    pass


@dataclass(frozen=True)
class Program:
    statements: tuple
    locations: tuple


class Parser:
    def __init__(self, text: str):
        if not text.strip() or len(text) > 32768:
            raise FormulaError('公式不能为空，且最多32768个字符')
        self.text = text
        self.tokens = []
        pos = 0
        for match in TOKEN.finditer(text):
            if match.start() != pos:
                self.error('无法识别的字符', pos)
            token = match.group()
            if not token.isspace() and not token.startswith(('{', '//')):
                self.tokens.append((token, match.start()))
            pos = match.end()
        if pos != len(text):
            self.error('无法识别的字符', pos)
        if len(self.tokens) > 8192:
            raise FormulaError('公式超过8192个词元')
        self.tokens.append(('', len(text)))
        self.i = 0
        self.names = set(INPUTS)
        self.depth = 0

    def error(self, message, pos=None):
        pos = self.tokens[self.i][1] if pos is None else pos
        line = self.text.count('\n', 0, pos) + 1
        column = pos - self.text.rfind('\n', 0, pos)
        raise FormulaError(f'第{line}行，第{column}列：{message}')

    def peek(self):
        return self.tokens[min(self.i, len(self.tokens)-1)][0].upper()

    def take(self, expected=None):
        raw = self.tokens[min(self.i, len(self.tokens)-1)][0]
        if not raw:
            self.error('公式意外结束，请检查括号与分号', len(self.text))
        if expected is not None and raw.upper() != expected:
            self.error(f'需要 {expected}，实际为 {raw or "公式结束"}')
        self.i += 1
        return raw

    def expression(self, minimum=0):
        self.depth += 1
        if self.depth > 64:
            self.error('表达式嵌套超过64层')
        token = self.take()
        upper = token.upper()
        if upper in ('-', '+', 'NOT', '!'):
            left = ('unary', upper, self.expression(6))
        elif token == '(':
            left = self.expression()
            self.take(')')
        elif token.startswith("'"):
            left = ('text', token[1:-1])
        elif re.fullmatch(r'(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?', token):
            value = float(token)
            if not math.isfinite(value):
                self.error('数字必须有限')
            left = ('number', value)
        elif self.peek() == '(':
            if upper not in FUNCTIONS and upper not in DRAWINGS:
                self.error(f'不支持函数 {token}')
            self.take('(')
            args = []
            if self.peek() != ')':
                while True:
                    args.append(self.expression())
                    if self.peek() != ',':
                        break
                    self.take(',')
            self.take(')')
            low, high = (FUNCTIONS | DRAWINGS)[upper]
            if not low <= len(args) <= high:
                self.error(f'{upper} 参数数量应为 {low}～{high}')
            left = ('call', upper, tuple(args))
        elif upper in self.names:
            left = ('name', upper)
        else:
            self.error(f'未知变量 {token or "公式结束"}')
        while self.peek() in BINARY and BINARY[self.peek()] >= minimum:
            op = self.take().upper()
            right = self.expression(BINARY[op] + (0 if op == '^' else 1))
            left = ('binary', op, left, right)
        self.depth -= 1
        return left

    def parse(self):
        statements = []
        locations = []
        while self.peek():
            if len(statements) >= 256:
                self.error('最多256条语句')
            pos = self.tokens[self.i][1]
            locations.append((self.text.count('\n', 0, pos)+1, pos-self.text.rfind('\n', 0, pos)))
            if self.peek() in DRAWINGS:
                key, mode = f'__draw_{len(statements)}', 'draw'
                expression = self.expression()
                if expression[0] != 'call' or expression[1] not in DRAWINGS:
                    self.error('绘图指令必须单独成句')
            else:
                key = self.take()
                if not re.fullmatch(r'[^\W\d]\w*', key) or key.upper() in self.names:
                    self.error('变量名非法、重复或占用行情字段')
                mode = self.take()
                if mode not in (':', ':='):
                    self.error('赋值使用 :=，绘图输出使用 :')
                expression = self.expression()
                self.names.add(key.upper())
            style = {'key': key, 'color': '#FACC15', 'width': 1, 'dash': False, 'hidden': mode == ':='}
            while self.peek() == ',':
                self.take(',')
                flag = self.take().upper()
                if flag.startswith('COLOR'):
                    value = flag[5:]
                    if value in COLORS:
                        style['color'] = COLORS[value]
                    elif re.fullmatch('[0-9A-F]{6}', value):
                        style['color'] = f'#{value}'
                    else:
                        self.error(f'不支持颜色 {flag}')
                elif re.fullmatch('LIGHTCOLOR[0-9A-F]{6}', flag):
                    style['light_color'] = '#' + flag[10:]
                elif re.fullmatch('LINETHICK[1-5]', flag):
                    style['width'] = int(flag[-1])
                elif flag == 'POINTDOT':
                    style['point_dot'] = True
                elif flag in ('DOTLINE', 'DOTLINE2'):
                    style['dash'] = True
                    if flag == 'DOTLINE2':
                        style['dash_size'] = 2
                elif flag == 'NODRAW':
                    style['hidden'] = True
                else:
                    self.error(f'不支持样式 {flag}')
            self.take(';')
            statements.append((key, mode, expression, style))
        if not statements:
            self.error('公式没有语句')
        for _, _, expression, _ in statements:
            pending = [(expression, 0)]
            while pending:
                node, depth = pending.pop()
                if depth > 64:
                    self.error('表达式树超过64层')
                children = node[2:] if node[0] in ('unary', 'binary') else node[2] if node[0] == 'call' else ()
                pending.extend((child, depth+1) for child in children)
        return Program(tuple(statements), tuple(locations))


@lru_cache(maxsize=256)
def compile_formula(source: str) -> Program:
    return Parser(source).parse()


def truth(value):
    return math.isfinite(value) and value != 0


class Interpreter:
    def __init__(self, rows, period, compare_days):
        self.n = len(rows)
        self.closed = [r.get('is_closed', i < self.n-1) is True for i, r in enumerate(rows)]
        if self.n > 20000:
            raise FormulaError('单次最多计算20000根K线')
        self.deadline = time.monotonic() + 3
        self.operations = 0
        self.env = {}
        for long, short in [('OPEN', 'O'), ('HIGH', 'H'), ('LOW', 'L'), ('CLOSE', 'C'), ('VOLUME', 'V')]:
            values = [r.get(long.lower()) for r in rows]
            array = [float(v) if isinstance(v, (int, float)) and math.isfinite(v) else NAN for v in values]
            self.env[long] = self.env[short] = array
        self.env['VOL'] = self.env['VOLUME']
        self.env['AMOUNT'] = [float(r['amount']) if isinstance(r.get('amount'), (int, float)) else NAN for r in rows]
        for key, value in {'PERIOD': {'30m': 30, '1d': 1440, '1w': 10080, '1mo': 43200}[period],
                           'COMPARE_DAYS': compare_days, 'DRAWNULL': NAN, 'TRUE': 1., 'FALSE': 0.}.items():
            self.env[key] = [value] * self.n

    def check(self):
        self.operations += self.n
        if self.operations > 8_000_000 or time.monotonic() > self.deadline:
            raise FormulaError('公式计算超时或超过运算限制')

    def run(self, node):
        self.check()
        kind, *args = node
        if kind == 'number':
            return [args[0]] * self.n
        if kind == 'text':
            return args[0]
        if kind == 'name':
            return self.env[args[0]]
        if kind == 'unary':
            op, child = args
            values = self.run(child)
            return [float(not truth(v)) if op in ('NOT', '!') else -v if op == '-' else v for v in values]
        if kind == 'binary':
            op, a, b = args
            left, right = self.run(a), self.run(b)
            fn = {'+': operator.add, '-': operator.sub, '*': operator.mul,
                  '=': operator.eq, '==': operator.eq, '!=': operator.ne, '<>': operator.ne,
                  '>': operator.gt, '<': operator.lt, '>=': operator.ge, '<=': operator.le}.get(op)
            result = []
            for x, y in zip(left, right, strict=True):
                if op in ('AND', '&&', 'OR', '||'):
                    value = (truth(x) and truth(y)) if op in ('AND', '&&') else (truth(x) or truth(y))
                elif not math.isfinite(x) or not math.isfinite(y):
                    value = 0. if op in ('=', '==', '!=', '<>', '>', '<', '>=', '<=') else NAN
                elif op == '/':
                    value = x / y if y != 0 else NAN
                elif op == '^':
                    try:
                        value = math.pow(x, y) if abs(y) <= 100 else NAN
                    except (ValueError, OverflowError):
                        value = NAN
                else:
                    value = fn(x, y)
                result.append(float(value))
            return result
        name, children = args
        if name in DRAWINGS:
            raise FormulaError('绘图指令只能单独成句')
        values = [self.run(c) for c in children]
        return self.function(name, values)

    def integer(self, values, minimum=1):
        if not values:
            return minimum
        value = values[0]
        if not math.isfinite(value) or int(value) != value or not minimum <= value <= 20000 or any(v != value for v in values):
            raise FormulaError(f'周期参数必须是{minimum}～20000的固定整数')
        return int(value)

    def pivot_levels(self, args):
        from app.indicators.pivots import pivot_candidate

        source, left_values, right_values, directions = args
        if isinstance(source, str):
            raise FormulaError('DRAWPIVOT价格序列必须为数值')
        left, right = self.integer(left_values), self.integer(right_values)
        direction = directions[0] if directions else 1
        if direction not in (-1, 1) or any(v != direction for v in directions):
            raise FormulaError('DRAWPIVOT方向必须为固定的1或-1')
        window = left + right + 1
        if window > 20000:
            raise FormulaError('DRAWPIVOT左右窗口合计最多20000根K线')
        # Nulls and unfinished candles cannot confirm a pivot; choose the last equal extremum.
        values = pl.Series([v if closed and math.isfinite(v) else None
                            for v, closed in zip(source, self.closed, strict=True)], dtype=pl.Float64)
        rolling = values.rolling_max if direction == 1 else values.rolling_min
        confirmed_values = values.to_list()
        extremes = rolling(window).to_list()
        right_extremes = rolling(right).to_list()
        breaks = self.env['HIGH' if direction == 1 else 'LOW']
        active, heap = {}, []
        for i, current in enumerate(breaks):
            if i % 256 == 0:
                self.check()
            if not math.isfinite(current):
                # An unknown high/low could have broken every existing level.
                active.clear()
                heap.clear()
                continue
            while heap and direction * current > heap[0][0]:
                _, value = heapq.heappop(heap)
                active.pop(value, None)
            if extremes[i] is None or right_extremes[i] is None:
                continue
            pivot = i-right
            value = source[pivot]
            if (not pivot_candidate(confirmed_values, pivot, direction, left, right)
                    or direction * value < direction * extremes[i]
                    or direction * value <= direction * right_extremes[i]
                    or direction * current > direction * value or value in active):
                continue
            active[value] = {'value': value, 'pivot_index': pivot, 'confirmed_index': i}
            heapq.heappush(heap, (direction * value, value))
            if len(active) > MAX_PIVOT_LEVELS:
                active.pop(next(iter(active)))
        return list(active.values())

    def function(self, name, args):
        a = args[0]
        n = self.n
        if name == 'IF':
            return [x if truth(c) else y for c, x, y in zip(*args, strict=True)]
        if name == 'NZ':
            other = args[1] if len(args) > 1 else [0.] * n
            return [v if math.isfinite(v) else other[i] for i, v in enumerate(a)]
        if name in ('ABS', 'SQRT', 'SIGN', 'ISVALID'):
            return [float(math.isfinite(v)) if name == 'ISVALID' else abs(v) if name == 'ABS' else
                    math.sqrt(v) if name == 'SQRT' and v >= 0 else
                    (float((v > 0) - (v < 0)) if math.isfinite(v) else NAN) if name == 'SIGN' else NAN for v in a]
        if name in ('MAX', 'MIN'):
            fn = max if name == 'MAX' else min
            return [fn(x, y) if math.isfinite(x) and math.isfinite(y) else NAN for x, y in zip(*args, strict=True)]
        if name == 'REF':
            result = []
            for i, distance in enumerate(args[1]):
                if math.isfinite(distance):
                    if distance < 0 or int(distance) != distance or distance > 20000:
                        raise FormulaError('REF只允许0～20000根的历史引用')
                    result.append(a[i-int(distance)] if i >= distance else NAN)
                else:
                    result.append(NAN)
            return result
        if name == 'CROSS':
            b = args[1]
            return [0.] + [float(all(math.isfinite(v) for v in (a[i], b[i], a[i-1], b[i-1])) and a[i] > b[i] and a[i-1] <= b[i-1]) for i in range(1, n)] if n else []
        if name in ('BARSCOUNT', 'BARSLAST', 'FILTER', 'VALUEWHEN'):
            result, last, count, blocked, held = [], None, 0, -1, NAN
            window = self.integer(args[1], 0) if name == 'FILTER' else 0
            for i, value in enumerate(a):
                if name == 'BARSCOUNT':
                    count = count + 1 if math.isfinite(value) else 0
                    out = count
                elif name == 'BARSLAST':
                    if truth(value):
                        last = i
                    out = i-last if last is not None else NAN
                elif name == 'VALUEWHEN':
                    if truth(value):
                        held = args[1][i]
                    out = held
                else:
                    out = float(truth(value) and i > blocked)
                    if out:
                        blocked = i + window
                result.append(float(out))
            return result
        window = self.integer(args[1])
        if name in ('EMA', 'SMA'):
            weight = 2/(window+1) if name == 'EMA' else self.integer(args[2]) / window
            if weight > 1:
                raise FormulaError('SMA权重不能大于周期')
            skip = len(args) == (3 if name == 'EMA' else 4) and truth(args[-1][0])
            previous, result = NAN, []
            for value in a:
                if not math.isfinite(value):
                    if not skip:
                        previous = NAN
                else:
                    previous = value if not math.isfinite(previous) else previous + weight*(value-previous)
                result.append(previous)
            return result
        series = pl.Series(a, dtype=pl.Float64).fill_nan(None)
        if name in ('MA', 'HHV', 'LLV', 'SUM', 'COUNT', 'STD'):
            method = {'MA': 'rolling_mean', 'HHV': 'rolling_max', 'LLV': 'rolling_min',
                      'SUM': 'rolling_sum', 'COUNT': 'rolling_sum', 'STD': 'rolling_std'}[name]
            if name == 'COUNT':
                series = pl.Series([float(truth(v)) for v in a])
            result = getattr(series, method)(window_size=window).to_list()
            return [NAN if v is None else float(v) for v in result]
        if name == 'SLOPE':
            denominator = window * (window*window-1) / 12
            if not denominator:
                raise FormulaError('SLOPE周期至少为2')
            self.operations += n*window
            self.check()
            result = [NAN] * n
            for i in range(window-1, n):
                sample = a[i-window+1:i+1]
                if all(math.isfinite(v) for v in sample):
                    result[i] = sum((j-(window-1)/2)*(v-sample[0]) for j, v in enumerate(sample))/denominator
            return result
        raise FormulaError(f'不支持函数 {name}')


def evaluate(program: Program, rows: list[dict], period='1d', compare_days=1) -> dict:
    if len(rows) * len(program.statements) > 1_000_000:
        raise FormulaError('公式与K线组合超过内存限制，请减少历史范围或语句数')
    interpreter = Interpreter(rows, period, compare_days)
    columns, figures, drawings = {}, [], []
    try:
        for _statement_index, (key, mode, node, style) in enumerate(program.statements):
            if mode == 'draw':
                _, kind, children = node
                if kind == 'DRAWPIVOT':
                    levels = interpreter.pivot_levels([interpreter.run(child) for child in children])
                    drawings.append({**style, 'kind': kind, 'fields': [], 'text': [], 'levels': levels})
                    continue
                fields, text = [], []
                for i, child in enumerate(children):
                    value = interpreter.run(child)
                    if isinstance(value, str):
                        text.append([i, value])
                    else:
                        column = f'{key}_{i}'
                        columns[column] = value
                        fields.append([i, column])
                text_positions = {i for i, _ in text}
                required_text = {'DRAWTEXT': {2}, 'TOOLTIP': {1}, 'HLINE': set()}.get(kind, set())
                allowed_text = {'DRAWTEXT': {2}, 'TOOLTIP': {1, 3}, 'HLINE': {1}}.get(kind, set())
                if not required_text <= text_positions or not text_positions <= allowed_text:
                    raise FormulaError('绘图文字参数必须使用单引号文本，其他参数必须为数值')
                def argument(index, key=key):
                    return columns.get(f'{key}_{index}', [])
                if kind == 'DRAWSEGMENT' and any(
                    truth(condition) and (not math.isfinite(start) or start < 0 or start > i or int(start) != start)
                    for i, (condition, start) in enumerate(zip(argument(0), argument(1), strict=True))
                ):
                    raise FormulaError('DRAWSEGMENT只能引用当前或已经确认的历史索引')
                if kind == 'DRAWICON' and any(v not in (1, 2) for v in argument(2)):
                    raise FormulaError('DRAWICON仅支持1向上箭头、2向下箭头')
                if kind == 'DRAWLINE' and any(v != 0 for v in argument(4)):
                    raise FormulaError('DRAWLINE仅支持已确认线段，第5参数必须为0')
                if kind == 'STICKLINE' and any(not math.isfinite(v) or not 0 <= v <= 8 for v in argument(3)):
                    raise FormulaError('STICKLINE宽度必须为0～8')
                drawings.append({**style, 'kind': kind, 'fields': fields, 'text': text})
            else:
                value = interpreter.run(node)
                if isinstance(value, str):
                    raise FormulaError('变量输出必须为数值')
                interpreter.env[key.upper()] = value
                columns[key] = value
                if mode == ':':
                    figures.append(style)
    except (FormulaError, TypeError, IndexError, KeyError, OverflowError, pl.exceptions.PolarsError) as exc:
        line, column = program.locations[_statement_index]
        message = str(exc) if isinstance(exc, FormulaError) else '参数类型错误或计算超限'
        raise FormulaError(f'第{line}行，第{column}列：{message}') from exc
    pivot_levels = sorted((level['confirmed_index'], drawing_index, level_index)
                          for drawing_index, drawing in enumerate(drawings)
                          for level_index, level in enumerate(drawing.get('levels', [])))
    if len(pivot_levels) > MAX_PIVOT_LEVELS:
        retained = {(drawing_index, level_index) for _, drawing_index, level_index
                    in pivot_levels[-MAX_PIVOT_LEVELS:]}
        for drawing_index, drawing in enumerate(drawings):
            if 'levels' in drawing:
                drawing['levels'] = [level for level_index, level in enumerate(drawing['levels'])
                                     if (drawing_index, level_index) in retained]
    result = [{key: float(values[i]) if math.isfinite(values[i]) else None for key, values in columns.items()} for i in range(len(rows))]
    return {'rows': result, 'figures': figures, 'drawings': drawings}
