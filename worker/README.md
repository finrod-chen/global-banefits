
# Worker 版（Cloudflare Workers）

與 GitHub Actions 版並存的線上版本：Cron Triggers 每 2 小時掃一次，看板用網頁即時渲染，掃描發現來源變更時自動用 LLM 提取優惠草稿。

## 檔案

- src/index.js：Worker 本體（scheduled 掃描、LLM 提取、fetch 提供看板與 API）
- src/dashboard.js：看板網頁版面（票券式優惠卡、專區分頁、搜尋與排序、深淺色、手機版）
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

## LLM 提取層（v2）

- 設定：Worker 的 Settings → Variables and Secrets 加 LLM_API_KEY（建議用 Secret 類型）。值是 Bearer token；呼叫方式 Authorization: Bearer <LLM_API_KEY>。
- endpoint 與模型寫死在 src/index.js 的 LLM 常數：https://apihub.agnes-ai.com/v1（OpenAI 相容 /chat/completions）、模型 agnes-3.0-flash。要換模型或端點直接改那裡。
- 行為：掃描發現來源「頁面內容變更」或「首次見到」時，把頁面內容（截 12,000 字）交給 LLM 提取優惠欄位；每輪最多 5 個來源，沒輪到的排入 KV 的 llm-backlog 佇列，下一輪優先處理。
- 產出：一律 status=pending（待核實）、價值不填數字、來源標注「LLM 自動提取，待人工核實」。人工核實後把 status 改成 verified（直接編輯 repo 的 data/deals.json 後重部署，或在 KV 裡改）。
- 沒設 LLM_API_KEY 時 AI 層自動停用，掃描其餘功能不受影響；last-run 的 aiExtraction 欄位會記錄 attempted / extracted / deferred / errors。
- 如實說明：LLM 可能誤讀頁面，草稿未經核實請勿當成事實；數字類欄位（價值）一律留空待人填。

## 端點

- / ：看板網頁（繁體中文，即時從 KV 渲染）
- /api/deals ：目前有效優惠 JSON
- /api/last-run ：最近一次掃描報告（含待核實佇列與 AI 提取統計）
- /healthz ：健康檢查

## 如實說明的邊界

- KV 資料與 repo 是各自獨立的副本：部署時 sources 會從 repo 覆蓋同步，deals 等只在不存在時種入；之後兩邊各自演進，不會自動互相同步（要同步需另接 GitHub API 與 token，目前不含）。
- 免費方案額度足夠：每 2 小時一次 = 每天 12 次觸發，KV 寫入約百次/天，遠低於限額。
