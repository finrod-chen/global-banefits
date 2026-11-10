#!/usr/bin/env bash
# 這支腳本已不需要做事，保留只是為了讓 Cloudflare Workers Builds 現有的設定不會壞掉：
# 那裡的 Build command 還是 `bash worker/deploy.sh`，檔案不存在的話 build 會直接失敗。
#
# 以前它負責建立 KV namespace、替換 wrangler.toml 的 id、部署、種子化 KV，
# 現在看板直接讀 GitHub repo 的資料，不再使用 KV；部署由 Deploy command 的 `npx wrangler deploy` 完成，
# 設定檔在 repo 根目錄的 wrangler.toml。
#
# 要徹底清掉：到 Cloudflare 的 Worker → Settings → Build，把 Build command 清空，再刪除這支腳本。
echo "worker/deploy.sh：不需要做事，部署由 Deploy command（npx wrangler deploy）完成。"
