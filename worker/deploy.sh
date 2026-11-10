#!/usr/bin/env bash
# GLOBAL DEAL RADAR - Cloudflare Workers Builds 部署腳本
# 用法：在 Cloudflare 的 Workers Builds 設定，把 Deploy command 設為：
#   bash worker/deploy.sh
# （Root directory 維持 repo 根目錄不用改）
# 這支腳本會：自動建立/找到 DEAL_DATA KV namespace、把 id 寫進 wrangler.toml（僅 build 環境內）、
# 部署 Worker、種子化 KV（sources 每次覆蓋，deals/state/archive 只在不存在時種入）。

set -euo pipefail
cd "$(dirname "$0")"

echo "== 1. 確認 KV namespace =="
NS_ID=$(npx wrangler kv namespace list 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const a=JSON.parse(d);const n=a.find(x=>(x.title||'').includes('DEAL_DATA'));console.log(n?n.id:'')}catch(e){console.log('')}})")
if [ -z "$NS_ID" ]; then
  echo "找不到 DEAL_DATA namespace，自動建立..."
  OUT=$(npx wrangler kv namespace create DEAL_DATA)
  NS_ID=$(echo "$OUT" | grep -oE '[0-9a-f]{32}' | head -1)
  echo "已建立 namespace：$NS_ID"
fi
echo "namespace id: $NS_ID"
if [ -z "$NS_ID" ]; then
  echo "無法取得 namespace id，請把 build log 貼回來檢查" >&2
  exit 1
fi

echo "== 2. 寫入 wrangler.toml（僅 build 環境內，不影響 repo）=="
sed -i.bak "s/REPLACE_WITH_NAMESPACE_ID/$NS_ID/" wrangler.toml
grep -q "$NS_ID" wrangler.toml || { echo "wrangler.toml 替換失敗" >&2; exit 1; }

echo "== 3. 部署 Worker =="
npx wrangler deploy

echo "== 4. 種子化 KV =="
npx wrangler kv key put sources --path ../data/sources.json --namespace-id "$NS_ID" --remote
seed_if_missing() {
  if ! npx wrangler kv key get "$1" --namespace-id "$NS_ID" --remote >/dev/null 2>&1; then
    npx wrangler kv key put "$1" --path "$2" --namespace-id "$NS_ID" --remote
    echo "seeded $1"
  else
    echo "keep existing $1"
  fi
}
seed_if_missing deals ../data/deals.json
seed_if_missing state ../data/state.json
seed_if_missing archive ../data/archive.json

echo "== 完成：看板網址見 Cloudflare 面板的 Worker 網域 =="
