# 缠论结构计算

## 数据流与规则

现有 K 线仓库 / 展示行情服务 → `api/kline.py` 的标准化、周期聚合和闭合标记 → `services/chanlun.py` → `chanlunQuery.ts` → 图表覆盖层、缠论面板和 AI 页面快照。

计算只在请求 `include_chanlun=true` 时执行。默认 K 线响应不变，不写 Parquet、用户配置或交易数据。前端不再独立计算缠论，不在失败时回退到旧结构代理。

公开内核为 MIT 许可的 Vespa314/chan.py，固定 commit `429d6ed3043e27c93a003ba2b10e70a05575e1f5`，详见 `backend/app/vendor/chanpy/UPSTREAM.md`。仅引入计算源码，没有新增运行依赖。业务契约版本为 3；不是上游版本号。上游绝对导入已限定在项目命名空间。

使用严格笔、特征序列线段和引擎中枢规则；笔背驰比较 MACD 面积，线段背驰比较斜率。背驰比率显式固定为 0.9，避免上游默认无穷阈值无条件放行。完整配置、内核来源随响应返回，UI 显示的趋势分类仍是中枢位置近似，不能宣称完整走势递归。

## HTTP 契约

日线：`GET /api/kline/daily`。30 分钟、周、月：`GET /api/kline/period`。

沿用现有 symbol、日期范围、days 参数，增加：

| 参数 | 含义 |
| --- | --- |
| `include_chanlun` | 默认 false，按需附带 `chanlun` 结构 |
| `chanlun_source` | `stroke` 或 `segment`，默认 stroke |
| `chanlun_as_of` | 可选北京墙钟，日期表示当日结束，分钟观察时刻原样保留 |

分析窗口与响应 K 线相同。不同历史起点可能产生不同结构，前端查询键包含日期范围；比较引擎结果必须使用相同数据窗口。30 分钟沿用已有实际交易日裁剪、午休分桶与原生行情路由，不启用上游取数。

## 时间与信号

- 结构发生时间与最早可知时间分开。逐根喂入已闭合 K 线，记录结构/信号首次出现；回看在喂入前截断。
- 未闭合或闭合状态未知的 K 线不创建或确认结构；其价格可以使已经出现的候选失效。
- 历史上午观察不能使用当日下午收盘的完整日线；尚未结束的周/月也不能用于确认。
- 结构的 `confirmed` 表示引擎对结构的判断。信号独立记录 `structureConfirmed`、`availableDate`、`invalidatedAt` 和 `invalidationReason`；单周期信号仍标候选，未实现次级别联立确认。
- 保留上游 1/1p/2/2s/3a/3b 子类型，不把盘整背驰 1p 当成严格趋势一买。
- 候选的价格失效边界采用信号 K 线低点（买）或高点（卖），`boundaryRule=signal_bar_extreme`，这是工程规则，不冒充中枢边界。后续触及边界或引擎移除该形态均保留失效记录。
- 图表候选点、背驰标记按最早可知时间定位；笔和线段按实际端点绘制，形成中结构用虚线。
- 多周期表仍为只读对照。尚未新增缠论策略、通知规则或成交模拟；后续消费者应直接复用这个计算服务和同一时间契约。

## 缓存与验证

后端最多缓存 16 份不可变计算结果，键包含完整 OHLC、时间、闭合状态、周期和结构来源，每次返回独立副本。价格修订、复权与闭合状态变化自然失效；内核升级随进程重启清除缓存。缓存不是持久化引擎状态。

前端查询键包含标的、资产类型、周期、窗口、来源、观察时刻及分析刷新版本；不使用另一上下文的结果占位。手动重新计算会刷新分析版本，多周期查询也随该版本失效。

验证入口：

```sh
cd backend
uv run --frozen pytest tests/test_chanlun.py tests/test_kline_periods.py -q
uv run --frozen ruff check app/services/chanlun.py tests/test_chanlun.py
cd ../frontend
pnpm test:chanlun
pnpm exec vitest run src/components/StockPanel.test.tsx src/components/KLineCandlestick.test.tsx src/lib/stockChatContext.test.ts
pnpm build
```
