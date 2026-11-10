# Worker 版（Cloudflare Workers）

與 GitHub Actions 版並存的線上版本：Cron Triggers 每 2 小時掃一次，看板用網頁即時渲染。

## 檔案

- src/index.js：Worker 本體（scheduled 掃描、fetch 提供看板與 API）
- wrangler.toml：cron 每 2 小時、KV binding DEAL_DATA（namespace id 由部署流程自動寫入）
- ../.github/workflows/deploy-worker.yml：CI 部署（push 到 main 且動到 worker/** 或 data 時觸發，也可手動 Run）

## 部署前需要（倉庫擁有者設定）

Settings → Secrets and variables → Actions 加兩個 secret：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID。Token 權限需要 Account 層級的 Workers Scripts:Edit 與 Workers KV Storage:Edit。

KV namespace 不用預先建：部署流程查不到 DEAL_DATA 會自動建立並把 id 寫回 wrangler.toml。

## 端點

- / ：看板網頁（繁體中文，即時從 KV 渲染）
- /api/deals ：目前有效優惠 JSON
- /api/last-run ：最近一次掃描報告（含待核實佇列）
- /healthz ：健康檢查

## 如實說明的邊界

- KV 資料與 repo 是各自獨立的副本：部署時 sources 會從 repo 覆蓋同步，deals 等只在不存在時種入；之後兩邊各自演進，不會自動互相同步（要同步需另接 GitHub API 與 token，目前不含）。
- Worker 版不做 AI 提取，行為與 scripts/scan.mjs 相同：頁面級變更偵測 + 待核實佇列。
- 免費方案額度足夠：每 2 小時一次 = 每天 12 次觸發，KV 寫入約百次/天，遠低於限額。
