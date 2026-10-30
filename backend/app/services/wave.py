"""Causal daily price-shape candidates, without recursive Elliott subwave claims."""

VERSION = 'wave-v3-alpha-0.14.3-r1'


def analyze_wave(rows, period='1d', as_of=None):
    from app.services.wave_engine import calculate
    return calculate(rows, period, as_of)


def _shape(points, rows):
    d = 1 if points[0]['side'] == 'low' else -1
    v = [d*p['value'] for p in points]
    if not (v[2] > v[0] and v[3] > v[1]):
        return False
    if len(v) >= 5 and v[4] <= v[1]:
        return False
    if len(v) >= 6 and (v[5] <= v[3] or v[3]-v[2] < min(v[1]-v[0], v[5]-v[4])):
        return False
    if len(v) >= 8 and v[7] >= v[5]:
        return False
    if len(v) >= 9 and v[8] >= v[6]:
        return False
    # Check every closed bar inside correction legs, not only pivot endpoints.
    for leg, boundary in ((2, v[0]), (4, v[1])):
        if len(v) <= leg:
            continue
        inside = rows[points[leg-1]['index']+1:points[leg]['index']+1]
        if any(d*(r['low'] if d == 1 else r['high']) <= boundary for r in inside if r['closed']):
            return False
    return True


def confluence(dow, wave):
    if dow['status'] != 'ok' or not wave['candidates']:
        return '证据不足,暂不生成一致性判断'
    if dow['damaged']:
        return '原趋势受损,波浪提供候选解释,仍待道氏重新确认'
    candidates = wave['candidates']
    if len({(c['direction'], c['stage']) for c in candidates}) > 1:
        return '存在不同解释,请分别观察候选验证条件'
    c = candidates[0]
    active = c.get('currentPosition', {})
    if not active or active.get('active') is None:
        return '当前浪位未可靠识别,暂不生成一致性判断'
    if active.get('direction') != c['direction']:
        return '可能处于趋势中的回撤或反弹,不能据此确认反转'
    return '当前方向一致,波浪补充阶段信息' if dow['trend'] == active['direction'] else '出现反向结构,但原趋势尚未确认改变'
