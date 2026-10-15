export interface FormulaStick {
  value: number[]
  itemStyle: { color: string }
}

/** 通达信STICKLINE：保留上下端、按4个宽度单位为一个柱间距，并裁剪到副图。 */
export function buildFormulaSticks(name: string, data: FormulaStick[]): any {
  return {
    name, type: 'custom', data,
    dimensions: ['index', 'from', 'to', 'width'], encode: { x: 0, y: [1, 2] },
    renderItem: (params: any, api: any) => {
      const from = api.coord([api.value(0), api.value(1)])
      const to = api.coord([api.value(0), api.value(2)])
      const width = Math.abs(api.size([1, 0])[0]) * api.value(3) / 4
      const x = Math.max(params.coordSys.x, from[0] - width / 2)
      const right = Math.min(params.coordSys.x + params.coordSys.width, from[0] + width / 2)
      const y = Math.max(params.coordSys.y, Math.min(from[1], to[1]))
      const bottom = Math.min(params.coordSys.y + params.coordSys.height, Math.max(from[1], to[1]))
      if (right <= x || bottom <= y) return
      return { type: 'rect', shape: { x, y, width: right - x, height: bottom - y }, style: { fill: api.visual('color') } }
    },
    silent: true, animation: false,
  }
}
