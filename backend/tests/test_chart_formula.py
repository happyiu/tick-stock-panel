from __future__ import annotations

import pytest

from app.indicators.chart_formula import FormulaError, compile_formula, evaluate


def test_formula_values_styles_and_causal_signals():
    source = '中线:MA(CLOSE,3),COLORRED,LINETHICK2; 上穿:=CROSS(CLOSE,中线); DRAWICON(上穿,LOW,1);'
    rows = [{'close': v, 'low': v-1} for v in [3,2,1,2,4,3]]
    result = evaluate(compile_formula(source), rows)
    assert result['rows'][0]['中线'] is None
    assert result['rows'][2]['中线'] == 2
    assert result['rows'][3]['上穿'] == 1
    assert result['figures'][0] == {'key': '中线', 'color': '#FF0000', 'width': 2, 'dash': False, 'hidden': False}
    assert evaluate(compile_formula(source), rows[:4])['rows'] == result['rows'][:4]


def test_pointdot_keeps_values_colors_width_and_hidden_outputs():
    source = ('上轴:1,COLORGRAY,POINTDOT; 点:MA(C,2),POINTDOT,COLORWHITE,LINETHICK3;'
              '隐藏:C,POINTDOT,NODRAW; 普通:C,COLORRED;')
    result = evaluate(compile_formula(source), [{'close': v} for v in [1, 3, 5]])
    assert [row['点'] for row in result['rows']] == [None, 2, 4]
    assert result['figures'][0] == {
        'key': '上轴', 'color': '#808080', 'width': 1, 'dash': False,
        'hidden': False, 'point_dot': True,
    }
    assert result['figures'][1]['width'] == 3
    assert result['figures'][1]['color'] == '#FFFFFF'
    assert result['figures'][2]['hidden'] is True
    assert 'point_dot' not in result['figures'][3]


@pytest.mark.parametrize('source', [
    'X:REF(CLOSE,-1);', 'X:BACKSET(CLOSE,2);', 'X:__import__(1);',
    'X:UNKNOWN;', 'X:MA(CLOSE,0);', 'X:CLOSE.foo;', 'X:MA(CLOSE);',
    'X:CLOSE,COLORWHATEVER;', 'X:=CLOSE;X:HIGH;',
    'X:', 'X:MA(', 'X:MA(CLOSE,', 'HLINE(1)+1;',
    'DRAWSEGMENT(1,100,CLOSE);', 'DRAWSEGMENT(1,-1,CLOSE);',
])
def test_reject_unsupported_or_unsafe_formula(source):
    with pytest.raises(FormulaError):
        evaluate(compile_formula(source), [{'close': 1., 'high': 2.}])


def test_dynamic_ref_filter_and_missing_volume():
    source = 'S:=CLOSE>2; AGE:BARSLAST(S),NODRAW; LAST:REF(CLOSE,AGE); F:FILTER(S,2),NODRAW; VV:MA(VOL,2);'
    result = evaluate(compile_formula(source), [{'close': v} for v in [1,3,1,1,4,5]])
    assert [r['LAST'] for r in result['rows']] == [None,3,3,3,4,5]
    assert [r['F'] for r in result['rows']] == [0,1,0,0,1,0]
    assert all(r['VV'] is None for r in result['rows'])


def test_execution_budget_and_location():
    rows = [{'close': 1.}] * 10000
    with pytest.raises(FormulaError, match='第2行'):
        evaluate(compile_formula('X:=CLOSE;\nY:SLOPE(X,10000);'), rows)
    with pytest.raises(FormulaError, match='64层'):
        compile_formula('X:' + '+'.join(['CLOSE']*1000) + ';')
    for source in ("DRAWTEXT(1,1,1);", 'DRAWICON(1,1,3);', 'DRAWLINE(1,1,1,2,1);'):
        with pytest.raises(FormulaError):
            evaluate(compile_formula(source), [{'close': 1.}])
