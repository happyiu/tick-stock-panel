# 日 K 图表维护

本次迁移基线为 `dev` 的 `d1b8f4a`，保留该分支全部页面与业务能力。
基础 K 图表使用固定版本 `klinecharts@10.1.0`。入口为
`frontend/src/components/KLineCandlestick.tsx`，由 `StockDailyKChart` 和指数页复用；
自选详情与回测弹窗通过 `StockPanel` 接入。单日/多日分时、个股分析图与列表迷你图仍使用各自现有实现。

当前为分阶段迁移：基础蜡烛、MA/BOLL 与 VOL/MACD/RSI/KDJ 使用新引擎。
天使魔鬼、boll2、KD背离/增强版、ETF波段、多空趋势、缠论覆盖层和隐藏日期调试
继续由 `EChartsCandlestick` 绘制，沿用原公式、信号和信息面板；切换到这些功能时由入口自动选择原引擎。
不要删除这条路径，直到这些能力在新引擎中逐项迁移并通过验证。
30分钟/日/周/月周期、ETF三位价格精度、策略/信号选择和本地指标设置均保留。

## 数据与指标

- 沿用现有 API、React Query 查询键、SSE 和 `daily/latest` 缓存合并，不由图表另建网络订阅。
- `lib/kline-chart.ts` 将日期或30分钟墙钟时间按北京时间转为毫秒时间戳，将 `amount` 映射为 `turnover`，不转换成交量单位。
- MA、MACD、RSI、KDJ、BOLL 使用 `TSP_*` 自定义指标投影后端计算列；不能直接替换为同名内置指标，参数、历史预热和 BOLL 标准差口径可能不同。
- VOL5/VOL10 包含当天；量能倍数为当前成交量除以前 N 个交易日均量，不包含当天，零分母和历史不足显示缺失。
- 同日末根变化与新增一日通过 `setDataLoader.subscribeBar` 的回调更新；历史修订和窗口变化使用 `resetData`，保留浏览位置。切股重置视图和悬停。
- 当前只显示调用方请求的日期窗口，`getBars` 返回 `more=false`，不额外向边界分页取数。

## 业务交互

`lib/kline-chart-overlays.ts` 管理程序生成的买卖/涨停/炸板、自选日、区间和价格线覆盖物。
业务覆盖物锁定位置并阻止右键删除；涨停标签在可见根数大于 60 时简化为圆点，买卖箭头保留。
预警价格参与主图纵轴范围。蜡烛点击回传日期，主图双击经公开坐标转换 API 回传价格；副图双击不触发价格预警。

## 验证与升级

```bash
cd frontend
pnpm exec vitest run src/lib/kline-chart.test.ts src/lib/kline-chart-overlays.test.ts src/components/KLineCandlestick.test.tsx src/components/EChartsIntraday.test.tsx src/pages/Indices.test.tsx
pnpm build
```

浏览器检查 ETF/股票/指数切换、指标多开与移除、量能周期、标注、日期点击、双击预警、缩放拖动后的刷新、主题和窄屏。
10.x 使用 `setDataLoader`；旧版 `applyNewData/updateData` 已移除。官网部分示例与发布包类型存在差异，升级时以锁定包的 `.d.ts` 和源码为准，并重跑上述测试。
