
# 維運手冊（RUNBOOK）

## 日常流程

1. 掃描：GitHub Actions 每 2 小時跑一次 scripts/scan.mjs，跑完自動執行 scripts/build-dashboards.mjs 重建看板並提交。
2. 待核實：有設 LLM_API_KEY 時，變更的頁面會自動產生 status=pending 的草稿；沒設的話看 data/last-run.json 的 needsReview 欄位，自己按 docs/SCHEMA.md 寫條目。
3. 人工核實：點開官方頁面確認草稿內容。Worker 版在看板的管理模式按「核實通過」或「退回」；GitHub Actions 版直接改 data/deals.json 的 status。
4. 下一輪掃描會自動：去重（同名 + 同官方連結）、歸檔過期條目、重建看板。

## 新增監控來源

編輯 data/sources.json 加一條：id（唯一英文識別）、category、name、url（只用官方網域）、watchKeywords（關注關鍵字陣列；掃描時這些關鍵字全部從頁面消失會標記 suspect-expired）、enabled（設為 false 可暫時停用）。

## 已實作的自動化

- 每 2 小時定時掃描（GitHub Actions cron 與 Cloudflare Worker cron 各一份；GitHub 排程可能有 10 到 30 分鐘延遲）
- 官方頁面雜湊比對、變更偵測、疑似失效偵測（關鍵字消失）；HTTP 4xx/5xx 一律算擷取失敗
- 重複優惠去重、過期自動歸檔
- AI 自動提取優惠草稿（含地區與資格條件）：頁面先去掉 script 與標籤再交給 LLM；同一來源的舊草稿會被新一輪取代，不會越積越多；人工退回過的不會再被塞回來
- 推播通知（Telegram）：新草稿、三天內截止、疑似失效、來源剛開始擷取失敗、過期歸檔；沒事不發
- 人工審核：Worker 看板的管理模式可以一鍵「核實通過／退回」，也能立即掃描
- 看板自動重建、掃描報告與每條優惠的最後驗證時間記錄

掃描邏輯只有一份：worker/src/core.mjs，GitHub Actions（scripts/scan.mjs）與 Worker（worker/src/index.js）共用。

## 需要設定金鑰才會啟用的功能

沒設的功能自動停用，不影響其餘流程。Worker 版在 Cloudflare 面板的 Worker → Settings → Variables and Secrets 設；GitHub Actions 版在 repo 的 Settings → Secrets and variables → Actions 設。

| 名稱 | 用途 | Worker | GitHub Actions |
|---|---|---|---|
| LLM_API_KEY | AI 提取草稿 | 支援 | 支援 |
| TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID | 推播通知 | 支援 | 支援 |
| ADMIN_TOKEN | 看板管理模式（核實、退回、立即掃描） | 支援 | 不適用 |
| DASHBOARD_URL | 通知訊息附上的看板網址（選填，一般變數即可） | 支援 | 支援 |
| CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID | 從 GitHub Actions 部署 Worker | 不適用 | 支援 |

Telegram 設定：找 @BotFather 建 bot 拿 token；對 bot 傳一則訊息後開 https://api.telegram.org/bot<token>/getUpdates 找 chat.id。兩邊都設 Telegram 會各發一次，建議只設在 Worker。

ADMIN_TOKEN 自己產一串夠長的隨機字串（例如 openssl rand -hex 24）。

## 還沒有的

- Worker 的 KV 與 repo 的 data/ 是兩份獨立資料，不會互相同步。在看板核實的結果只在 KV；repo 這份要另外改 data/deals.json。
- 通知管道目前只有 Telegram，沒有郵件與 Slack。
- GitHub 會在倉庫 60 天無活動時自動暫停排程，有新提交就會重置計時。

## 本機執行

- node scripts/scan.mjs
- node scripts/build-dashboards.mjs
- 需要 Node 18 以上（用了內建 fetch）
