# ruff: noqa: RUF001
"""Indicator management routes registered through the existing extension API."""
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app.extensions import BACKEND_EXTENSION_API_VERSION, BackendExtensionRegistrar
from app.indicators import chart_catalog
from app.indicators.chart_formula import COLORS, DRAWINGS, FUNCTIONS, FormulaError

EXTENSION_ID = 'chart.indicators'
EXTENSION_API_VERSION = BACKEND_EXTENSION_API_VERSION
router = APIRouter(prefix='/api/indicators', tags=['indicators'])


class Definition(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=80)
    pane: str
    description: str = Field(default='', max_length=2000)
    formula: str = Field(min_length=1, max_length=32768)
    revision: int | None = Field(default=None, ge=1)
    copy_from: str | None = Field(default=None, max_length=64)
    monitor_signals: list[dict] = Field(default_factory=list, max_length=32)
    min_history_bars: int = Field(default=100, ge=1, le=20000)


class FormulaValidation(Definition):
    name: str = Field(default='', max_length=80)


def _dir(request):
    return request.app.state.repo.store.data_dir


def _call(fn, *args):
    try:
        return fn(*args)
    except chart_catalog.CatalogError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except FormulaError as exc:
        raise HTTPException(422, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(503, '指标文件读写失败，请检查数据目录权限与磁盘空间') from exc


@router.get('')
def indicators(request: Request):
    return _call(chart_catalog.list_indicators, _dir(request))


@router.get('/language')
def language():
    return {'functions': FUNCTIONS, 'drawings': DRAWINGS, 'colors': COLORS,
            'help': '赋值用 :=，曲线输出用 :，语句以分号结束。支持中文变量、{注释}和//注释。\n'
            '行情字段：OPEN/HIGH/LOW/CLOSE、VOL、AMOUNT。PERIOD为30/1440/10080/43200；COMPARE_DAYS为量能对比周期。\n'
            'MA/HHV/LLV/SUM/COUNT/STD需要完整窗口；STD使用N-1。EMA从首个有效值初始化，缺值重置；SMA(X,N,M)权重为M/N，第4参数为1时跳过缺值。\n'
            'REF可使用动态非负历史偏移；BARSLAST在首次命中前为空。FILTER在命中后冷却N根。\n'
            '样式：COLORRED/COLORRRGGBB、LIGHTCOLORRRGGBB、LINETHICK1～5、DOTLINE/DOTLINE2、POINTDOT（曲线逐根画点，粗细决定点径）、NODRAW。\n'
            'STICKLINE(条件,起点,终点,宽度,空心)；DRAWTEXT(条件,位置,\'文字\'[,右对齐1])；DRAWICON(条件,位置,1或2[,箭头尺寸])。\n'
            'DRAWSEGMENT(条件,起点索引,数值序列)在确认时连至当前值；DRAWLINE(起点条件,起点值,终点条件,终点值,0)。\n'
            'DRAWPIVOT(价格序列,左根数,右根数,方向)仅用于主图；方向1为压力、-1为支撑，通常分别传HIGH和LOW。\n'
            '拐点在右侧K线收盘后确认；压力被最高价严格突破或支撑被最低价严格跌破时整条移除，同价触碰保留。最多显示最近确认的500条有效线，不能用最终剩余线倒推历史交易信号。\n'
            'HLINE(数值[,\'标签\'])为参考线；TOOLTIP(数值,\'名称\'[,小数位,\'后缀\'])为辅助提示。\n'
            '不支持未来引用、任意代码或完整通达信指令集；最多20000根K线、256条语句，单指标最多3秒。'}


class Evaluation(BaseModel):
    ids: list[str] = Field(max_length=32)
    rows: list[dict] = Field(max_length=20000)
    symbol: str = Field(default='', max_length=80)
    period: Literal['30m', '1d', '1w', '1mo'] = '1d'
    compare_days: int = Field(default=1, ge=1, le=20)


@router.post('/evaluate')
def evaluate_loaded(body: Evaluation, request: Request):
    if any(not isinstance(row.get('date'), str) or not 1 <= len(row['date']) <= 32 for row in body.rows):
        raise HTTPException(422, '每根K线必须包含有效日期')
    payload = {'rows': body.rows, 'symbol': body.symbol, 'period': body.period}
    return _call(chart_catalog.attach_results, payload, _dir(request), ','.join(body.ids), body.compare_days)


@router.post('/validate')
def validate(body: FormulaValidation):
    payload = body.model_dump()
    # Formula checks can run before the user names the indicator; saving still requires a name.
    payload['name'] = body.name.strip() or '公式校验'
    program = _call(chart_catalog.validate_definition, payload)
    return {'valid': True, 'variables': chart_catalog.formula_variables(program)}


@router.post('')
def create(body: Definition, request: Request):
    return _call(chart_catalog.save_indicator, _dir(request), body.model_dump(exclude_unset=True))


@router.get('/{indicator_id}')
def detail(indicator_id: str, request: Request):
    return _call(chart_catalog.get_indicator, _dir(request), indicator_id)


@router.put('/{indicator_id}')
def update(indicator_id: str, body: Definition, request: Request):
    return _call(chart_catalog.save_indicator, _dir(request), body.model_dump(exclude_unset=True), indicator_id)


@router.delete('/{indicator_id}')
def delete(indicator_id: str, request: Request, revision: int):
    _call(chart_catalog.delete_indicator, _dir(request), indicator_id, revision)
    return {'deleted': True}


def setup(registrar: BackendExtensionRegistrar):
    registrar.include_router(router)
