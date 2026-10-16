# 日 K 图表维护

基础迁移起点为 `dev` 的 `d1b8f4a`；缠论与调试迁移基线为 `6db7f0e`，保留现有业务能力。
基础 K 图表使用固定版本 `klinecharts@10.1.0`。入口为
`frontend/src/components/KLineCandlestick.tsx`，由 `StockDailyKChart` 和指数页复用；
自选详情与回测弹窗通过 `StockPanel` 接入；独立个股分析页的 `AnalysisKChart` 也复用该入口。
单日/多日分时与列表迷你图仍使用各自现有实现。

当前基础蜡烛、MA/BOLL、VOL/MACD/RSI/KDJ，以及天使魔鬼、boll2、KD背离/增强版、ETF波段、多空趋势使用新引擎。
缠论覆盖层和隐藏日期调试也使用同一个 KLineChart 实例，切换不再更换引擎。
`EChartsCandlestick` 文件仅保留历史导入路径兼容导出，不包含 ECharts 绘图实现。
30分钟/日/周/月周期、ETF三位价格精度、策略/信号选择和本地指标设置均保留。

## 数据与指标

- 沿用现有 API、React Query 查询键、SSE 和 `daily/latest` 缓存合并，不由图表另建网络订阅。
- `lib/kline-chart.ts` 将日期或30分钟墙钟时间按北京时间转为毫秒时间戳，将 `amount` 映射为 `turnover`，不转换成交量单位。
- MA、MACD、RSI、KDJ、BOLL 使用 `TSP_*` 自定义指标投影后端计算列；不能直接替换为同名内置指标，参数、历史预热和 BOLL 标准差口径可能不同。
- VOL5/VOL10 包含当天；量能倍数为当前成交量除以前 N 个交易日均量，不包含当天，零分母和历史不足显示缺失。
- 同日末根变化与新增一日通过 `setDataLoader.subscribeBar` 的回调更新；历史修订和窗口变化使用 `resetData`，保留浏览位置。切股重置视图和悬停。
- 当前只显示调用方请求的日期窗口，`getBars` 返回 `more=false`，不额外向边界分页取数。

## 自定义公式

`lib/kline-chart-formulas.ts` 注册六个 `TSP_*` 指标，直接复用现有 `calculate*` 函数。
天使魔鬼替换默认MA，并保留空心红色多头、实心青色空头及原价格坐标上的进攻/撤退标记；boll2保留延后一根的通道。
四个副图使用原生曲线和箭头，自定义绘制参考线、KD背离连线、STICKLINE及信号文字；柱线保留上下端和按柱间距计算的宽度。
多空趋势接收显式周期，切换周期时触发重算；纵轴保留小于0、大于100的数值，防守价/趋势价只出现在提示中。
缺失成交量通过 `source_volume` 保留，不能被原生量柱使用的零值替代；不改动公式预热、确认延迟或信号冷却。
副图提示随十字线更新并自动换行；窄屏预留更多顶部空间。密集信号文字按可见区域避让，不显示边缘被截断的半个标签。

KLineChart 副图上方分隔线支持上下拖动。拖动后通过统一 `storage.stockPreviewSubChartHeights` 保存各副图的绘图区高度，切换周期、主题、指标排序、关闭重开或刷新页面时保持；窄屏换行仅增加提示区高度，不重置绘图区。主图保留至少120px，副图绘图区保留至少50px。日期轴固定在主图与副图之间，隐藏日期调试时不显示日期文字。

## 缠论、调试与独立分析页

`lib/kline-chart-chanlun.ts` 将已有 `ChanlunAnalysis` 投影为分型、笔、线段代理、中枢、候选买卖点与背驰代理覆盖物，不重算分析。笔和线段按确认状态区分虚实线；候选买卖点按 `availableDate` 定位，等待状态不显示为候选。悬停说明保留结构发生、最早可知、失效边界及证据；隐藏日期时同时隐藏信息栏、日期轴、十字线和缠论说明中的日期。

独立 `/stock-analysis` 页的关键价位图保留分组开关、枢轴档位、压力支撑与曲线双向高亮。`lib/kline-chart-levels.ts` 绘制水平价位、布林/Keltner/ATR 后端序列，按日期对齐，缺失处不连线；右侧预留标签空间，范围条通过公开 API 控制与同步缩放。不恢复 `d1b8f4a` 已移除的自选详情关键价位功能。

## 业务交互

自选详情使用与关键价位分析一致的卡片边框、内边距、轻量工具按钮和范围条，默认可见120根K线。OHLC/均线信息、指标选择及副图高度设置继续保留。容器尺寸改变时，等待原生画布布局完成后再适配默认视野；用户已经手动缩放或拖动时保持原有浏览位置。

`lib/kline-chart-overlays.ts` 管理程序生成的买卖/涨停/炸板、自选日、区间和价格线覆盖物。
业务覆盖物锁定位置并阻止右键删除；涨停标签在可见根数大于 60 时简化为圆点，买卖箭头保留。
预警价格参与主图纵轴范围。蜡烛点击回传日期，主图双击经公开坐标转换 API 回传价格；副图双击不触发价格预警。

## 验证与升级

```bash
cd frontend
pnpm exec vitest run src/lib/kline-chart*.test.ts src/components/KLineCandlestick.test.tsx src/components/EChartsCandlestick.test.tsx src/components/StockDailyKChart.test.tsx src/components/stock-analysis/AnalysisKChart.test.tsx src/pages/Indices.test.tsx
pnpm build
```

浏览器检查 ETF/股票/指数切换、指标多开与移除、量能周期、标注、日期点击、双击预警、缩放拖动后的刷新、主题和窄屏。
10.x 使用 `setDataLoader`；旧版 `applyNewData/updateData` 已移除。官网部分示例与发布包类型存在差异，升级时以锁定包的 `.d.ts` 和源码为准，并重跑上述测试。
