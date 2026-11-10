
# 維運手冊（RUNBOOK）

## 日常流程

1. 掃描：GitHub Actions 每 2 小時跑一次 scripts/scan.mjs，跑完重建看板檔案並把 data/ 提交回 repo。
2. 草稿與 AI 預審：有設 LLM_API_KEY 時，變更的頁面會自動產生草稿，接著每條草稿做一次 AI 預審（見下方「已實作的自動化」）；沒設的話看 data/last-run.json 的 needsReview 欄位，自己按 docs/SCHEMA.md 寫條目。
3. 人工核實：優先看「AI 預審通過」的（卡片上有原文依據可以直接對照），點開官方頁面確認後，用下列任一方式放行；價值欄會帶入 AI 估值，可直接採用或修改：
   - 看板的管理模式按「核實通過」（可填估算價值）或「退回」（需要 Worker 設 ADMIN_TOKEN 與 GITHUB_TOKEN）。
   - 到 repo 的 Actions 頁手動執行 **Review Deal**，填優惠 id、動作、價值。
   - 直接改 data/deals.json 的 status。
4. 下一輪掃描會自動：去重、歸檔過期條目、重建看板。
5. 看板（Worker）讀的就是 repo 的 data/，提交後最慢約 1 分鐘更新。從看板按審核或掃描後，頁面會顯示「處理中」並在資料更新後自動重新整理。
6. 審核可以連續快速地按：Review Deal 在最新資料上重新套用，推送被拒絕就重來，不會互相覆蓋或悄悄遺失（不用 concurrency group，因為 GitHub 同一組只保留一個等待中的執行，第三個進來會取消第二個）。

## 新增監控來源

編輯 data/sources.json 加一條：id（唯一英文識別）、category、name、url（只用官方網域）、watchKeywords（關注關鍵字陣列；掃描時這些關鍵字全部從頁面消失會標記 suspect-expired）、enabled（設為 false 可暫時停用）。

## 已實作的自動化

- 每 2 小時定時掃描（GitHub Actions cron；GitHub 排程可能有 10 到 30 分鐘延遲）
- 官方頁面雜湊比對、變更偵測、疑似失效偵測（關鍵字消失）；HTTP 4xx/5xx 與空內容的回應都算擷取失敗
- 重複優惠去重、過期自動歸檔
- AI 自動提取優惠草稿（含地區與資格條件）：頁面先去掉 script 與標籤再交給 LLM；已核實的條目會告訴 LLM 不要重複；同一來源的舊草稿會被新一輪取代；人工退回過的不會再被塞回來；提取過的來源 12 小時內不重複提取
- 推播通知（Telegram）：新草稿、三天內截止、疑似失效、來源剛開始擷取失敗、過期歸檔；沒事不發
- AI 預審：LLM 為草稿的每個論點（優惠內容、條件、截止日、地區）附上頁面原文引文，**程式逐字比對引文是否真的在頁面上**，並檢查摘要裡的數字是否在頁面上、連結網域是否與來源一致、截止日是否已過、LLM 是否判斷為常態定價。全部通過才標「AI 預審通過」，其餘維持待核實並在卡片上列出疑慮。每條草稿預審一次，失敗最多重試 3 次，每輪最多預審 8 條
- AI 估值：頁面原文有明確金額（且原文找得到）才依固定匯率 1 USD = 32 TWD 換算，標「依原文金額」；沒有明確金額則是 AI 推測，標「推測」並附依據與信心（推測的信心最高只給 medium，模型自評的 high 不採信）。「依原文金額」只證明那個金額在頁面上，不保證它屬於這一條優惠：同一個頁面有多個優惠時，金額可能被套到不對的那條。估值不會自動寫進 value，放行時沒填就採用、填了就以你填的為準，備註會記下是採用還是修改過
- 人工審核：Review Deal workflow，看板按鈕也能觸發
- 看板（Cloudflare Worker）：讀 repo 的資料即時渲染，有專區分頁、搜尋、排序、深淺色、手機版

## 需要設定金鑰才會啟用的功能

沒設的功能自動停用，不影響其餘流程。

| 名稱 | 用途 | 設在哪 |
|---|---|---|
| LLM_API_KEY | AI 提取草稿 | repo secrets（Settings → Secrets and variables → Actions） |
| TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID | 推播通知 | repo secrets |
| ADMIN_TOKEN | 看板管理模式的密碼 | Worker 的 Variables and Secrets |
| GITHUB_TOKEN | 讓看板按鈕觸發 Actions（fine-grained token，只給這個 repo 的 Actions: Read and write） | Worker 的 Secret |
| CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID | 從 GitHub Actions 部署 Worker（備援路線） | repo secrets |

Telegram 設定：找 @BotFather 建 bot 拿 token；對 bot 傳一則訊息後開 https://api.telegram.org/bot<token>/getUpdates 找 chat.id。

ADMIN_TOKEN 自己產一串夠長的隨機字串（例如 openssl rand -hex 24）。

## 還沒有的

- 「AI 預審通過」不是人工核實：LLM 讀的是同一個頁面，程式只能驗證「引文在不在頁面上」，驗證不了頁面沒寫的條件（登入後才看得到的資格、地區限制）。頁面內容也可能夾帶要 LLM 照做的指示，所以預審的結論是由程式比對決定，不是 LLM 說了算。
- 疑似常態定價的草稿只會被標記，不會自動退回：目前沒有「還原已退回條目」的功能，單靠一個模型的判斷就自動丟掉不安全。
- AI 估值（尤其是「推測」）會參與看板的「價值高到低」排序，數字請當參考。
- Actions 的出口 IP 抓不到 OpenAI、Midjourney、Revolut、Namecheap（回 403），這四個來源目前一直是擷取失敗。
- 通知管道目前只有 Telegram，沒有郵件與 Slack。
- 看板讀的是公開 repo；repo 改成私有的話，Worker 的讀取方式要改。
- GitHub 會在倉庫 60 天無活動時自動暫停排程，有新提交就會重置計時。

## 本機執行

- node scripts/scan.mjs
- node scripts/build-dashboards.mjs
- 需要 Node 18 以上（用了內建 fetch）
