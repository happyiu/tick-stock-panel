# 波浪价格结构候选 v1

日线、左3右2已收盘拐点，三年窗口最多1500根。连续同类点保留更极端者，等值取后者；同根双点重置序列。最近24个交替点连续匹配，最多两个候选；不验证内部子浪，不提供概率或目标价。

盘中会纳入当日实时日K作为形成中数据并标记临时结果；未收盘K可影响当前状态和临时失效提示，但不会确认拐点或最终失效，收盘后按正式日K重新计算。

标准推动外形约束第二段不完全回撤、第三段越过第一段、第四段不重叠、第五段创新极值及第三段非最短；上涨下跌镜像。ABC仅接在有效五段后，B不回到推动终点、C越过A。候选包括端点发生/确认时间、阶段、规则、下一条件和失效边界。未完成推动的失效以已收盘K线极值检查；历史五段不因后续回撤被抹除。

接口 `/api/kline/daily?include_wave=true&wave_as_of=...` 默认关闭。返回 `wave`、同输入 `dow` 与 `confluence`。版本键和32项内容缓存隔离行情修订。前端独立 `tsp-wave` 覆盖组，选择单候选显示历史线段与编号，不进入手动画线流程。

参考：https://chartschool.stockcharts.com/table-of-contents/market-analysis/elliott-wave-analysis-articles/identifying-elliott-wave-patterns

限制：本版为外形匹配，不覆盖递归子浪、楔形、复杂调整；候选排名仅为确定性展示顺序。实际人工验收以交付记录为准。

## 浪位升级工作记录（未完成完整版）

`wave-v2-position-evidence` 分开最后确认端点与当前形成浪，新增 `counts/currentPosition/waveTree/validation/conditions/projections/revisions/dataCoverage`。ATR14的1/2/4倍用于因果性反向运动过滤；使用截至当时已收盘K线计算。内部子段目前仅为价格段证据，明确 `unverified_subdivision`，不能宣称已验证完整5-3-5结构。

尚未完成：递归形态语法验证、独立锯齿、分钟补充、平台/三角形/楔形/联合调整、搜索预算及完整主备排名、历史改判事件、子浪图层和完整人工验收。因此不能标为“常见形态完整版”。

## wave-v3-alpha-0.14.3-r1 实现记录

已接入固定校验和的 wave-alpha 0.14.3 MIT 规则核心（来源及许可见 wave_core/SOURCE.md、LICENSE），不引入它的数据获取、LLM 或交易信号流程。日期模型适配北京时间时间戳，使用现有高低价因果拐点；同根双点不清除已确认历史。八类模板外增加推动、楔形、三角形及调整的价格几何约束。

新增 POST `/api/stock-analysis/wave/analyze`，请求 `symbol/asset_type/as_of`，返回 `periods[1d|30m]`、方向对照、来源元数据与保存状态。历史列表 GET `/wave/history?symbol=&asset_type=`，详情 GET `/wave/history/{id}`，均位于 `/api/stock-analysis`。SQLite 位于运行时 user_data，保存失败不影响分析；同截止时间、版本及OHLC指纹去重。旧 include_wave 日线入口共用新引擎。

前端支持主备切换、两层子浪图层、分钟时间戳、条件情景虚线、失效参考线和历史读取。AI 仅接收同截止时刻的精简 wave 数据；旧 elliott 字段仍清理。

### 当前验收边界

- 子浪匹配采用相邻细级别拐点的完整边界匹配，不能匹配时保留 unresolved；递归上限两层，不表示无限递归完整数浪。
- 当前形成浪主要为已完成形态后的反向情景，尚未覆盖全部未完成模板前缀；复杂调整延伸仍会改判。
- 跨周期目前仅对照方向及复权声明，已按时间区间和方向提供嵌套参考及同分排序，但尚未实现跨周期子浪语法证明。
- 搜索最多取每级最近96个拐点；没有时间预算截断，不进入行情线程或列表批量计算。
- 历史结果标注 reconstructed：沿用当前行情复权基准，尚未实现历史因子版本重建。因此不能声称严格复现过去真实可见的行情。
- `backend/scripts/replay_wave.py` 输入标准OHLC JSON，输出1/3/5根稳定性及确认延迟。`wave-replay-validation.json` 是三只ETF最近90根日线的重建报告；已报告可跟踪候选的失效撤销延迟；分钟覆盖和跨周期稳定性尚未完整量化。
- 本轮不包含交易信号、收益验证或 WXYXZ。
