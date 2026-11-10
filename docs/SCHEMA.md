# 优惠条目数据格式（data/deals.json）

每个优惠是一个 JSON 对象，字段如下。看板和扫描器都按这个格式读写。

| 字段 | 必填 | 说明 |
|---|---|---|
| id | 是 | 唯一标识，英文短横线命名，如 gcp-free-trial |
| name | 是 | 活动名称 |
| category | 是 | ai / crypto / banking / vps-cloud / software / other |
| summary | 是 | 优惠内容，一两句话说清楚给什么 |
| value | 建议 | 对象：type（cash / credit / discount / free）、amountUSD、valueTWD、note。价值用于排行榜排序，估不出来就留空，在 note 里说明 |
| requirements | 是 | 参与条件，包括隐藏条件（绑卡、消费门槛、邀请要求） |
| regions | 是 | 适用国家或地区 |
| startDate | 可 | 开始日期，YYYY-MM-DD，未知填 null |
| endDate | 可 | 截止日期，YYYY-MM-DD；长期活动填 null 并把 ongoing 设为 true |
| ongoing | 是 | 长期活动为 true，限时活动为 false |
| steps | 是 | 参与步骤，从第 1 步开始列 |
| officialUrl | 是 | 官方活动链接，只接受官方域名 |
| source | 是 | 信息来源与核对方式（哪天开的哪个页面） |
| lastVerified | 是 | 最后验证时间，YYYY-MM-DD |
| risks | 是 | 风险提示（扣款、自动续费、资格失效等） |
| status | 是 | verified（已核实）/ pending（待核实）/ expired（过期，会被扫描器自动归档） |

## 特别要求

- 区分四类活动：真正免费、免费试用（到期会开始收费）、需要充值或消费门槛、需要邀请或推荐条件。四类必须在 requirements 和 risks 里写清楚。
- 不要编造：官方页面看不到的数字一律不写，宁可填 null 并把 status 设为 pending（待核实）。
- status 为 example 的示例条目只用于文档演示，不进看板、不参与归档。
