import type { OverlayTemplate } from 'klinecharts'

export function waveLegLabel(label: string, parent?: string, forming = false): string {
  const name = /^\d+$/.test(label) ? `第${label}浪` : `${label}浪`
  return `${parent ? `${parent} · 子浪 ` : ''}${name}${forming ? '（形成中）' : ''}`
}

export const waveSegmentTemplate: OverlayTemplate<{ label: string; dashed?: boolean; child?: boolean; textColor?: string }> = {
  name: 'TSP_WAVE_SEGMENT', totalStep: 3,
  needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
  createPointFigures: ({ chart, overlay, coordinates }) => {
    if (coordinates.length < 2) return []
    const [start, end] = coordinates
    const { label, dashed, child, textColor } = overlay.extendData
    const color = child ? '#8B5CF6' : '#A78BFA'
    return [
      { type: 'line', attrs: { coordinates: [start, end] }, styles: { color, size: child ? 1 : 1.5, style: dashed ? 'dashed' : 'solid', dashedValue: [4, 3] }, ignoreEvent: true },
      { type: 'text', attrs: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 8, text: label, align: 'center', baseline: 'bottom' }, styles: { color: textColor ?? color, size: child ? 10 : 11, backgroundColor: chart.getStyles().separator.color, paddingLeft: 3, paddingRight: 3 }, ignoreEvent: true },
    ]
  },
}
