
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
| status | 是 | verified（已核實）/ pending（待核實）/ expired（過期，會被掃描器自動歸檔） |

## 特別要求

- 區分四類活動：真正免費、免費試用（到期會開始收費）、需要儲值或消費門檻、需要邀請或推薦條件。四類必須在 requirements 和 risks 裡寫清楚。
- 不要編造：官方頁面看不到的數字一律不寫，寧可填 null 並把 status 設為 pending（待核實）。
- status 為 example 的範例條目只用於文件演示，不進看板、不參與歸檔。
