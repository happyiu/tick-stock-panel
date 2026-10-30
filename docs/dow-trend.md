# 道氏趋势 v1

单标的趋势分析应用，支持周线、日线、30分钟；多周期同向不是传统道氏理论的指数互相确认。不提供交易指令或确定目标价。

## 规则

规则版本 `dow-v1-left3-right2`。左3右2已闭合K线确认局部高低点，允许左侧等值，右侧严格比较。每点记录发生和确认时间；同根双点保留，但不能据此确认反转。高低点各自比较生成 HH/HL/LH/LL，等值为 EH/EL。

两侧共同升高/降低形成结构，收盘突破前一个同类拐点确认趋势。先检查旧保护位，再处理新确认点；影线越界单独记录。趋势受损保留原方向，仅新结构确认解除受损或反转。事件固定引用价位，并按种类、锚点及方向去重。

量能取事件成交量除以前20根已收盘均量，1.2倍为工程阈值；缺量不阻断价格分析。界面固定查询周线5年、日线3年、30分钟120自然日，最多1500根，图表缩放不改变窗口。

## 接口与历史观察

现有 `/api/kline/daily`、`/api/kline/period` 可选参数 `include_dow=true`、`dow_as_of`，默认不计算。结果附在 `dow`，包含规则版本、覆盖边界、结构、趋势、受损状态、拐点、事件、关键位和量能。

历史截止先截断再计算，使用北京墙钟及 `period_end`/`is_closed`。32项LRU按规范化数据内容、周期、截止及版本缓存；行情修订自然失效。复权沿用图表数据服务；引擎无法从裸OHLC自行证明供应商复权正确性。

前端右侧“道氏趋势”按需查询，沿用分析快照刷新。独立 `tsp-dow` 图层不进入用户画线存储。观察日期或标的改变后标注默认关闭。

## 参考

- https://chartschool.stockcharts.com/table-of-contents/market-analysis/dow-theory
- https://python.stockindicators.dev/indicators/Pivots/
- https://github.com/facioquo/stock-indicators-dotnet
- https://github.com/coding-kitties/PyIndicators/blob/main/pyindicators/indicators/swing_structure.py
- https://github.com/MarcosACH/chart-patterns

调研日期：2026-10-29。参考公开算法说明，未复制上述项目源码或引入其运行依赖。本项目以固定规则版本、确认时刻和前缀一致性测试作为行为依据。

## 第二轮（dow-v2-left3-right2）

默认展示日线结论、结构原因、后续条件和周期对照。原始拐点、发生/确认时间及事件记录折叠在“查看分析依据”。主图仅显示每侧最近两个拐点、最近一次非影线状态事件，相同价位合并标签。

新增可选 `basis`、`paths`、`breakoutVolume` 字段。条件路径的确认参考位与状态机使用同一前序拐点；保护位单独标记是否已经受损。突破量能绑定最近确认/反转事件，不被影线事件覆盖。旧字段保留。

## 验收修复（dow-v3-left3-right2）

确认事件增加 `structureId`，条件路径增加可选 `structureReady`。历史确认引用不可变事件；新结构不继承旧确认。受损时记录当时结构，须出现新结构并满足收盘条件才允许重新确认。30分钟输入统一以观察日期前120个自然日裁剪，随后限制1500根；不改变其他图表查询窗口。
