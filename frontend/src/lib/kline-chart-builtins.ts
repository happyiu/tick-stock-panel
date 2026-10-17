/** 保留已有 TSP 指标口径；新增指标直接使用 KLineChart 的默认公式和参数。 */
export const BUILTIN_MAIN_INDICATORS = [
  { key: 'builtin-ema', name: 'EMA', label: 'EMA 指数均线' },
  { key: 'builtin-sma', name: 'SMA', label: 'SMA 平滑均线' },
  { key: 'builtin-bbi', name: 'BBI', label: 'BBI 多空指标' },
  { key: 'builtin-sar', name: 'SAR', label: 'SAR 抛物转向' },
]
export const BUILTIN_SUB_INDICATORS = [
  { name: 'BIAS', label: '乖离率' }, { name: 'BRAR', label: '情绪指标' },
  { name: 'CCI', label: '顺势指标' }, { name: 'DMI', label: '趋向指标' },
  { name: 'CR', label: '能量指标' }, { name: 'PSY', label: '心理线' },
  { name: 'DMA', label: '平行线差' }, { name: 'TRIX', label: '三重指数平滑' },
  { name: 'OBV', label: '能量潮' }, { name: 'VR', label: '成交量变异率' },
  { name: 'WR', label: '威廉指标' }, { name: 'MTM', label: '动量指标' },
  { name: 'EMV', label: '简易波动' }, { name: 'AO', label: '动量震荡' },
  { name: 'ROC', label: '变动率' }, { name: 'PVT', label: '价量趋势' },
].map(({ name, label }) => ({ key: `builtin-${name.toLowerCase()}`, name, label: `${name} ${label}`, height: 100 }))
// AVP 需要成交额与价格、成交量使用相同复权和数量单位，当前行情契约不能直接满足。
export const BUILTIN_INDICATORS = [...BUILTIN_MAIN_INDICATORS, ...BUILTIN_SUB_INDICATORS]
export const builtinIndicator = (key: string) => BUILTIN_INDICATORS.find(indicator => indicator.key === key)
