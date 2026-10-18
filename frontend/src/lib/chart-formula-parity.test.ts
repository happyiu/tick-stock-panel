import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { calculateAngelDevil } from './angelDevil'
import { calculateBoll2 } from './boll2'
import { calculateKdDivergence } from './kdDivergence'
import { calculateKdEnhanced } from './kdEnhanced'
import { calculateEtfSwingV2 } from './etfSwingV2'
import { calculateBullBearTrendV2 } from './bullBearTrendV2'

const backend = resolve(import.meta.dirname, '../../../backend')
const python = `import json,sys\nfrom pathlib import Path\nfrom app.indicators.chart_formula import compile_formula,evaluate\np=json.load(sys.stdin)\nr={}\nfor key in p['keys']:\n d=json.loads((Path('app/indicators/chart_defaults')/(key+'.json')).read_text())\n r[key]=evaluate(compile_formula(d['formula']),p['bars'],p['period'])['rows']\nprint(json.dumps(r,allow_nan=False))`
let seed = 42, previous = 3
const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296 }
const bars = Array.from({ length: 1000 }, (_, i) => {
  const close = previous + (random() - 0.5) * 0.06 + Math.sin(i / 17) * 0.008
  const open = previous + (random() - 0.5) * 0.008
  const high = Math.max(open, close) + random() * 0.012, low = Math.min(open, close) - random() * 0.012
  const volume = 1000 * (0.6 + random() * 1.2)
  previous = close
  return { open, close, high, low, volume }
})
const keys = ['angel-devil', 'boll2', 'kd-divergence', 'kd-enhanced', 'etf-swing-v2', 'bull-bear-trend-v2']
for (const variant of ['normal', 'flat-missing-volume']) for (const period of ['1d', '30m', '1w', '1mo']) it(`原有六个公式逐根一致 ${variant} ${period}`, () => {
  const sample = bars.map((bar, i) => variant === 'normal' ? bar : i >= 100 && i < 150 ? { open: 3, high: 3, low: 3, close: 3, volume: 0 } : { ...bar, volume: i % 17 === 0 ? undefined : bar.volume })
  const actual = JSON.parse(execFileSync('uv', ['run', '--frozen', 'python', '-c', python], {
    cwd: backend, input: JSON.stringify({ bars: sample, period, keys }), maxBuffer: 25 * 1024 * 1024,
  }).toString())
  const expected = [calculateAngelDevil(sample.map(b => b.close)), calculateBoll2(sample.map(b => b.close)),
    calculateKdDivergence(sample), calculateKdEnhanced(sample), calculateEtfSwingV2(sample), calculateBullBearTrendV2(sample, period)]
  for (let k = 0; k < keys.length; k++) for (let i = 0; i < bars.length; i++) {
    for (const [field, value] of Object.entries(expected[k][i])) {
      if (field === 'signal') {
        expect(actual[keys[k]][i].attack, `${keys[k]}[${i}].attack`).toBe(Number(value === 'buy'))
        expect(actual[keys[k]][i].retreat, `${keys[k]}[${i}].retreat`).toBe(Number(value === 'sell'))
      } else {
        if (['bottomLineStart', 'topLineStart'].includes(field) && keys[k] === 'kd-enhanced') continue
        expect(field in actual[keys[k]][i], `missing ${keys[k]}.${field}`).toBe(true)
        const got = actual[keys[k]][i][field]
        if (value == null || typeof value === 'boolean') expect(got, `${keys[k]}[${i}].${field}`).toBe(value == null ? null : Number(value))
        else expect(got, `${keys[k]}[${i}].${field}`).toBeCloseTo(value as number, 8)
      }
    }
  }
}, 20000)

it('成交量均线与量比保留原图表数据口径', async () => {
  const { toChartBars } = await import('./kline-chart')
  const sample = bars.slice(0,100).map((bar,i) => ({ ...bar, date: `2026-${String(Math.floor(i/28)+1).padStart(2,'0')}-${String(i%28+1).padStart(2,'0')}`, volume: i%17 === 0 ? undefined : bar.volume }))
  const actual = JSON.parse(execFileSync('uv', ['run','--frozen','python','-c',python], { cwd: backend, input: JSON.stringify({ bars: sample, period: '1d', keys: ['vol'] }) }).toString()).vol
  const expected = toChartBars(sample,1)
  for (let i=0; i<sample.length; i++) {
    for (const field of ['vol_ma5','vol_ma10','volume_ratio']) {
      const value = expected[i][field]
      if (value == null) expect(actual[i][field]).toBeNull()
      else expect(actual[i][field]).toBeCloseTo(value as number,8)
    }
    expect(actual[i].volValue).toBe(expected[i].volume)
  }
})
