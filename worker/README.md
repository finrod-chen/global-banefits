
# Worker 版（Cloudflare Workers）

與 GitHub Actions 版並存的線上版本：Cron Triggers 每 2 小時掃一次，看板用網頁即時渲染。

## 檔案

- src/index.js：Worker 本體（scheduled 掃描、fetch 提供看板與 API）
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

兩條路線同時開會重複部署同一個 Worker（同程式碼，無害但沒必要）：走路線 A 就不必加 secrets，Actions 那條會因為缺 token 而失敗，屬正常，可忽略或停用。

## 端點

- / ：看板網頁（繁體中文，即時從 KV 渲染）
- /api/deals ：目前有效優惠 JSON
- /api/last-run ：最近一次掃描報告（含待核實佇列）
- /healthz ：健康檢查

## 如實說明的邊界

- KV 資料與 repo 是各自獨立的副本：部署時 sources 會從 repo 覆蓋同步，deals 等只在不存在時種入；之後兩邊各自演進，不會自動互相同步（要同步需另接 GitHub API 與 token，目前不含）。
- Worker 版不做 AI 提取，行為與 scripts/scan.mjs 相同：頁面級變更偵測 + 待核實佇列。
- 免費方案額度足夠：每 2 小時一次 = 每天 12 次觸發，KV 寫入約百次/天，遠低於限額。
