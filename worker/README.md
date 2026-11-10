# 看板 Worker（Cloudflare Workers）

把 GitHub repo 的資料畫成看板網頁。**資料只有一份，在 repo 的 `data/`**；掃描、AI 提取、通知都在 GitHub Actions（`.github/workflows/deal-hunter.yml`），Worker 自己不掃描、不存資料。

## 檔案

- `src/index.js`：Worker 入口。讀 repo 資料、提供看板與 API、管理端點（去觸發 GitHub Actions）。
- `src/dashboard.js`：看板版面（票券式優惠卡、專區分頁、搜尋與排序、深淺色、手機版、管理模式）。
- `src/core.mjs`：掃描核心與審核邏輯，給 `scripts/scan.mjs`、`scripts/review.mjs` 用；Worker 只用它的類別名稱對照。
- `src/notify.mjs`：Telegram 推播，給 `scripts/scan.mjs` 用。
- `wrangler.toml`：Worker 設定。沒有排程；`REPO_SLUG`、`REPO_BRANCH` 指定讀哪個 repo。
- `deploy.sh`：Cloudflare Workers Builds 用的部署腳本。
- `../.github/workflows/deploy-worker.yml`：GitHub Actions 部署（備援路線）。

## 資料怎麼來

repo 是公開的，Worker 直接讀 `raw.githubusercontent.com/<REPO_SLUG>/<REPO_BRANCH>/data/` 下的 `deals.json`、`archive.json`、`last-run.json`，不需要金鑰。結果在記憶體快取 60 秒，raw 本身還有約 5 分鐘快取，所以 Actions 提交後看板最慢約 6 分鐘更新。讀不到 GitHub 時沿用上一份資料，頁尾會標示。

要改讀別的 repo 或分支，改 `wrangler.toml` 的 `[vars]`。repo 若改成私有，目前的讀法就不能用了（需要加帶 token 的讀取）。

## 端點

- `GET /`：看板網頁
- `GET /api/deals`、`/api/archive`、`/api/last-run`：對應 repo 的三個檔案
- `GET /healthz`：健康檢查
- `POST /api/scan`：觸發 Actions 立即掃描
- `POST /api/deals/:id/verify`：核實通過，body 可帶 `{"valueTWD": 數字}`
- `POST /api/deals/:id/reject`：退回並歸檔

三個 POST 都要帶 `Authorization: Bearer <ADMIN_TOKEN>`；沒設 `ADMIN_TOKEN` 回 503。它們不直接改資料，而是呼叫 GitHub API 觸發 workflow（`deal-hunter.yml`、`review-deal.yml`），所以送出後約 1 分鐘資料才會更新。

## 設定（Worker 的 Settings → Variables and Secrets）

都是選填。

- `ADMIN_TOKEN`：看板管理模式與 POST 端點的密碼，自己產一串夠長的隨機字串。
- `GITHUB_TOKEN`（Secret）：讓看板按鈕能觸發 workflow。到 GitHub → Settings → Developer settings → Fine-grained tokens 建立，Repository access 只選這個 repo，權限只給 **Actions: Read and write**。沒設的話按鈕會回 503 並附上 GitHub 上手動執行的連結。

## 管理模式

看板頁尾點「管理模式」輸入 `ADMIN_TOKEN`（只存在該瀏覽器的 localStorage）。之後待核實的卡片出現「核實通過」（可順便填估算價值）與「退回」，頁首出現「立即掃描」。

不想設這兩個值也行：到 repo 的 Actions 頁手動執行 **Review Deal**（填優惠 id、動作、價值）或 **Deal Radar Scan**，效果相同。

## 部署

- **路線 A：Cloudflare Workers Builds（推薦）**：連接 GitHub repo 後，Deploy command 設為 `bash worker/deploy.sh`（Root directory 維持 repo 根目錄）。
- **路線 B：GitHub Actions（備援）**：repo secrets 加 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`（Account 層級 Workers Scripts: Edit 與 Workers KV Storage: Edit）；沒設時 workflow 會自動略過。

兩條路線同時開會重複部署同一個 Worker（無害但沒必要）。

`wrangler.toml` 裡的 KV 綁定（`DEAL_DATA`）**目前沒有程式使用**，保留只是因為兩個部署腳本會建立並替換它的 id，現在移除會讓部署失敗。確定不需要時，連同部署腳本裡的 KV 步驟一起清掉，並到 Cloudflare 刪除那個 namespace。

## 如實說明的邊界

- Actions 版抓不到 OpenAI、Midjourney、Revolut、Namecheap（回 403）。這些來源以前 Worker 自己掃時有幾個抓得到，現在沒有了。
- Cloudflare Workers Builds 預設每次 push 都會重新部署，包括 Actions 每 2 小時的資料提交；看板現在不需要這些部署，可以在 Cloudflare 的 Build 設定加上 watch paths 只在 `worker/**` 變更時建置。
