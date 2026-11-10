
# 維運手冊（RUNBOOK）

## 日常流程

1. 掃描：GitHub Actions 每 2 小時跑一次 scripts/scan.mjs，跑完重建看板檔案並把 data/ 提交回 repo。
2. 待核實：有設 LLM_API_KEY 時，變更的頁面會自動產生 status=pending 的草稿；沒設的話看 data/last-run.json 的 needsReview 欄位，自己按 docs/SCHEMA.md 寫條目。
3. 人工核實：點開官方頁面確認草稿內容，再用下列任一方式處理：
   - 看板的管理模式按「核實通過」（可填估算價值）或「退回」（需要 Worker 設 ADMIN_TOKEN 與 GITHUB_TOKEN）。
   - 到 repo 的 Actions 頁手動執行 **Review Deal**，填優惠 id、動作、價值。
   - 直接改 data/deals.json 的 status。
4. 下一輪掃描會自動：去重、歸檔過期條目、重建看板。
5. 看板（Worker）讀的就是 repo 的 data/，提交後最慢約 6 分鐘更新。

## 新增監控來源

編輯 data/sources.json 加一條：id（唯一英文識別）、category、name、url（只用官方網域）、watchKeywords（關注關鍵字陣列；掃描時這些關鍵字全部從頁面消失會標記 suspect-expired）、enabled（設為 false 可暫時停用）。

## 已實作的自動化

- 每 2 小時定時掃描（GitHub Actions cron；GitHub 排程可能有 10 到 30 分鐘延遲）
- 官方頁面雜湊比對、變更偵測、疑似失效偵測（關鍵字消失）；HTTP 4xx/5xx 與空內容的回應都算擷取失敗
- 重複優惠去重、過期自動歸檔
- AI 自動提取優惠草稿（含地區與資格條件）：頁面先去掉 script 與標籤再交給 LLM；已核實的條目會告訴 LLM 不要重複；同一來源的舊草稿會被新一輪取代；人工退回過的不會再被塞回來；提取過的來源 12 小時內不重複提取
- 推播通知（Telegram）：新草稿、三天內截止、疑似失效、來源剛開始擷取失敗、過期歸檔；沒事不發
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

- Actions 的出口 IP 抓不到 OpenAI、Midjourney、Revolut、Namecheap（回 403），這四個來源目前一直是擷取失敗。
- 通知管道目前只有 Telegram，沒有郵件與 Slack。
- 看板讀的是公開 repo；repo 改成私有的話，Worker 的讀取方式要改。
- GitHub 會在倉庫 60 天無活動時自動暫停排程，有新提交就會重置計時。

## 本機執行

- node scripts/scan.mjs
- node scripts/build-dashboards.mjs
- 需要 Node 18 以上（用了內建 fetch）
