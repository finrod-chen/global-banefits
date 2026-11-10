
# 優惠條目資料格式（data/deals.json）

每個優惠是一個 JSON 物件，欄位如下。看板和掃描器都按這個格式讀寫。

| 欄位 | 必填 | 說明 |
|---|---|---|
| id | 是 | 唯一識別，英文短橫線命名，如 gcp-free-trial |
| name | 是 | 活動名稱 |
| category | 是 | ai / crypto / banking / vps-cloud / software / other |
| summary | 是 | 優惠內容，一兩句話說清楚給什麼 |
| value | 建議 | 物件：type（cash / credit / discount / free）、amountUSD、valueTWD、note。價值用於排行榜排序，估不出來就留空，在 note 裡說明 |
| requirements | 是 | 參與條件，包括隱藏條件（綁卡、消費門檻、邀請要求） |
| regions | 是 | 適用國家或地區 |
| startDate | 可 | 開始日期，YYYY-MM-DD，未知填 null |
| endDate | 可 | 截止日期，YYYY-MM-DD；長期活動填 null 並把 ongoing 設為 true |
| ongoing | 是 | 長期活動為 true，限時活動為 false |
| steps | 是 | 參與步驟，從第 1 步開始列 |
| officialUrl | 是 | 官方活動連結，只接受官方網域 |
| source | 是 | 資訊來源與核對方式（哪天開的哪個頁面） |
| lastVerified | 是 | 最後驗證時間，YYYY-MM-DD |
| risks | 是 | 風險提示（扣款、自動續約、資格失效等） |
| status | 是 | verified（人工核實）/ ai-reviewed（AI 預審通過，沒有人看過）/ pending（待核實）/ expired（過期，會被掃描器自動歸檔） |
| review | 否 | AI 預審結果，只有 AI 提取的草稿才有。見下方「AI 預審欄位」 |
| valueEstimate | 否 | AI 估值，只有 AI 提取的草稿才有。見下方「AI 預審欄位」 |

## 特別要求

- 區分四類活動：真正免費、免費試用（到期會開始收費）、需要儲值或消費門檻、需要邀請或推薦條件。四類必須在 requirements 和 risks 裡寫清楚。
- 不要編造：官方頁面看不到的數字一律不寫，寧可填 null 並把 status 設為 pending（待核實）。
- status 為 example 的範例條目只用於文件演示，不進看板、不參與歸檔。

## AI 預審欄位

AI 提取的草稿一開始是 pending。掃描器接著對每條草稿預審一次：LLM 為每個論點附上頁面原文引文，**程式逐字比對引文是否真的在頁面上**（不採信 LLM 自己說的「有找到」），並檢查摘要裡的數字是否在頁面上、連結網域是否與來源一致、截止日是否已過。全部通過才標 ai-reviewed；這仍然不是「已核實」，只有人工放行才會變成 verified。

review：
- passed：是否全部通過
- coverage：{found, total}，找到原文依據的論點數／要求的論點數
- claims：每個論點的 {field, quote, found}，field 是 summary、requirements、endDate、regions 之一
- flags：疑慮清單，可能有 regular-pricing（疑似常態定價，不是促銷）、kind-unclear、domain-mismatch、numbers-missing、expired、quote-missing
- numbersMissing：摘要裡在頁面上找不到的數字
- kind、kindReason：LLM 對「是不是促銷」的判斷與理由
- at、model：預審時間與模型

valueEstimate：
- twd：估算價值（新台幣）
- basis：explicit-amount（頁面原文有明確金額，依固定匯率 1 USD = 32 TWD 換算）或 ai-estimate（AI 推測，頁面沒有明確金額）
- usd、quote：basis 為 explicit-amount 時，金額與它在頁面上的原文
- note、confidence：估值依據與信心（high、medium、low）

valueEstimate 不會自動寫進 value。人工放行時，沒填價值就採用 AI 估值，填了就以人工填的為準，value.note 會記下是採用還是修改過（含 AI 原估）。
