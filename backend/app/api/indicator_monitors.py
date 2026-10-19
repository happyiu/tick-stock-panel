"""Thin API for the independent indicator monitoring service."""
# ruff: noqa: RUF001
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app.indicators import chart_catalog

router = APIRouter(prefix='/api/indicator-monitors', tags=['indicator-monitors'])


class RuleInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    symbol: str = Field(min_length=1, max_length=80)
    asset_type: Literal['stock', 'etf'] = 'stock'
    indicator_id: str = Field(min_length=1, max_length=64)
    period: Literal['30m', '1d'] = '30m'
    signal_ids: list[str] = Field(min_length=1, max_length=32)
    mode: Literal['preview', 'confirmed', 'both'] = 'both'
    channels: list[Literal['system', 'feishu', 'wecom', 'custom', 'email']] = Field(default_factory=list)
    enabled: bool = True
    compare_days: int = Field(default=1, ge=1, le=20)


def service(request):
    result = getattr(request.app.state, 'indicator_monitor', None)
    if result is None:
        raise HTTPException(503, '指标监控服务不可用')
    return result


def call(function, *args):
    try:
        return function(*args)
    except KeyError as exc:
        raise HTTPException(404, '监控规则或记录不存在') from exc
    except (ValueError, chart_catalog.CatalogError) as exc:
        raise HTTPException(422, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(503, '指标监控文件无法读写') from exc


def validated(body, request):
    value = body.model_dump()
    asset = request.app.state.repo.resolve_asset_type(value['symbol'])
    if asset not in {'stock', 'etf'} or asset != value['asset_type']:
        raise HTTPException(422, '标的资产类型不匹配，仅支持股票与ETF')
    return value


@router.get('')
def rules(request: Request):
    return {'items': call(service(request).list)}


@router.post('')
def create(body: RuleInput, request: Request):
    return call(service(request).save, validated(body, request))


@router.get('/events')
def events(request: Request):
    return {'items': call(service(request).events)}


@router.delete('/events')
def clear_events(request: Request):
    call(service(request).clear_events)
    return {'cleared': True}


@router.post('/events/{event_id}/retry')
def retry(event_id: str, request: Request):
    call(service(request).retry, event_id)
    return {'queued': True}


@router.get('/{rule_id}/snapshot')
def snapshot(rule_id: str, request: Request, event_id: str | None = None):
    stored = call(service(request).snapshot, rule_id, event_id)
    item = stored['definition']
    result = call(chart_catalog._evaluate_for_chart, item['formula'], stored['rows'], stored['period'], stored['compare_days'])
    result.update(dates=[r['date'][:16 if stored['period'] == '30m' else 10] for r in stored['rows']],
                  name=item['name'], pane=item['pane'], revision=item['revision'],
                  min_value=item.get('min_value'), max_value=item.get('max_value'), precision=item.get('precision'))
    return dict(rows=stored['rows'], symbol=stored['symbol'], asset_type=stored['asset_type'], period=stored['period'],
                indicator_results={item['id']: result}, definition=item)


@router.get('/{rule_id}')
def detail(rule_id: str, request: Request):
    return call(service(request).get, rule_id)


@router.put('/{rule_id}')
def update(rule_id: str, body: RuleInput, request: Request):
    return call(service(request).save, validated(body, request), rule_id)


@router.post('/{rule_id}/adopt')
def adopt(rule_id: str, request: Request):
    return call(service(request).adopt, rule_id)


@router.delete('/{rule_id}')
def delete(rule_id: str, request: Request):
    call(service(request).delete, rule_id)
    return {'deleted': True}
