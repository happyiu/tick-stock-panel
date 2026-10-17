# chan.py 计算内核

- 来源：https://github.com/Vespa314/chan.py
- 固定提交：`429d6ed3043e27c93a003ba2b10e70a05575e1f5`
- 许可：MIT，见同目录 LICENSE，保留上游版权声明。
- 仅收录计算所需的 Bi、BuySellPoint、ChanModel/Features、Combiner、Common、KLine、Math、Seg、ZS 和 ChanConfig。
- 本地改动仅为绝对导入增加 `app.vendor.chanpy` 命名空间；不更改上游计算算法。
- 使用 `CKLine_List.add_single_klu` 逐根喂入标准化前复权 K 线，不启用上游行情源、绘图、交易或 pickle 接口。
- 业务配置和时间契约位于 `app/services/chanlun.py`。升级必须重新验证逐根回放、历史截断、候选失效和图表投影；不可仅替换源码后沿用旧缓存。
