
# Worker 版（Cloudflare Workers）

與 GitHub Actions 版並存的線上版本：Cron Triggers 每 2 小時掃一次，看板用網頁即時渲染，掃描發現來源變更時自動用 LLM 提取優惠草稿。

## 檔案

- src/index.js：Worker 入口（cron、KV 讀寫、路由、管理端點）
- src/core.mjs：掃描核心（擷取、變更偵測、去重、歸檔、LLM 提取、審核），與 scripts/scan.mjs 共用
- src/notify.mjs：Telegram 推播
- src/dashboard.js：看板網頁版面（票券式優惠卡、專區分頁、搜尋與排序、深淺色、手機版、管理模式）
- wrangler.toml：cron 每 2 小時、KV binding DEAL_DATA（namespace id 是佔位符，部署腳本會自動替換）
- deploy.sh：Cloudflare Workers Builds 用的部署腳本
- ../.github/workflows/deploy-worker.yml：GitHub Actions 部署（備援路線）

## 部署路線 A：Cloudflare Workers Builds（推薦，免 API Token）

1. 在 Cloudflare 把 GitHub repo 連接後，打開該 Worker 的 Settings → Build。
2. 把 Deploy command 設為：bash worker/deploy.sh（Root directory 維持 repo 根目錄）。
3. 合併 PR 後 push 會自動觸發；也可在 Cloudflare 面板手動 Retry build。

deploy.sh 會自動：找到或建立 DEAL_DATA KV namespace、把 id 寫進 wrangler.toml（只在 build 環境內，不動 repo）、部署、種子化 KV（sources 每次覆蓋，deals/state/archive 只在不存在時種入）。

若 build log 顯示未授權錯誤：在 Build 的環境變數加 CLOUDFLARE_API_TOKEN（Workers Builds 通常會自動帶入連線權限，多半不用）。

## 部署路線 B：GitHub Actions（備援，需要 secrets）

Settings → Secrets and variables → Actions 加 CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID；Token 權限需 Account 層級的 Workers Scripts:Edit 與 Workers KV Storage:Edit。workflow 會自動建立 KV namespace 並部署。

沒設這兩個 secrets 時 workflow 會自動略過部署並顯示提示，不會失敗。

兩條路線同時開會重複部署同一個 Worker（同程式碼，無害但沒必要）：走路線 A 就不必加 secrets。

## 設定（Worker 的 Settings → Variables and Secrets）

都是選填，沒設的功能自動停用。金鑰類請用 Secret 類型；wrangler deploy 不會清掉面板上設的 Secret。

- LLM_API_KEY：AI 提取草稿。Bearer token。
- TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID：推播通知。
- ADMIN_TOKEN：看板管理模式與 POST 端點。自己產一串夠長的隨機字串。
- DASHBOARD_URL：通知訊息附上的看板網址（一般變數即可）。

## AI 提取

- endpoint 與模型寫在 src/core.mjs 的 LLM 常數：https://apihub.agnes-ai.com/v1（OpenAI 相容 /chat/completions）、模型 agnes-3.0-flash。
- 掃描發現來源「內容變更」或「首次見到」時，把頁面去掉 script、style 與標籤後的文字（截 12,000 字）交給 LLM；每輪最多 5 個來源，沒輪到的排進 state 的 llmBacklog，下一輪優先處理。
- 產出一律 status=pending、價值不填數字。同一來源重新提取時，舊的待核實草稿會被新的取代；已核實的不動；人工退回過的不會再出現。
- LLM 可能誤讀頁面，草稿未經核實請勿當成事實。

## 推播通知

每輪掃描後，有下列任一情況才發一則 Telegram：新草稿、三天內截止（每條只提醒一次）、疑似失效、來源從正常變成擷取失敗、有條目過期歸檔。結果記在 last-run 的 notification 欄位。

## 管理模式

看板頁尾點「管理模式」輸入 ADMIN_TOKEN（只存在該瀏覽器的 localStorage）。之後待核實的卡片會出現「核實通過」（可順便填估算價值）與「退回」，頁首出現「立即掃描」。

## 端點

- GET / ：看板網頁
- GET /api/deals ：目前有效優惠
- GET /api/archive ：已過期、重複、退回的條目
- GET /api/last-run ：最近一次掃描報告
- GET /healthz ：健康檢查
- POST /api/scan ：立即掃描
- POST /api/deals/:id/verify ：核實通過，body 可帶 {"valueTWD": 數字}
- POST /api/deals/:id/reject ：退回並歸檔

三個 POST 端點都要帶 Authorization: Bearer <ADMIN_TOKEN>；沒設 ADMIN_TOKEN 時回 503。

## 如實說明的邊界

- KV 資料與 repo 是各自獨立的副本：部署時 sources 會從 repo 覆蓋同步，deals 等只在不存在時種入；之後兩邊各自演進，不會自動互相同步（要同步需另接 GitHub API 與 token，目前不含）。
- 請求數與 KV 寫入量遠低於免費方案限額（每天 12 次觸發）。但免費方案每次執行的 CPU 時間上限很低，一輪要抓十幾個頁面再做文字處理，有可能超時；last-run 長時間沒更新時先看 Worker 的 Logs。
