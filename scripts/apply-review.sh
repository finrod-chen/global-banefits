#!/usr/bin/env bash
# 套用一次人工審核並推送（由 .github/workflows/review-deal.yml 呼叫）
#   DEAL_ID=<id> ACTION=verify|reject [VALUE_TWD=<數字>] bash scripts/apply-review.sh
#
# 連續點好幾下審核時，不會互相覆蓋，也不會有哪一次被悄悄丟掉：
# 每次嘗試都先重設到遠端最新，在最新資料上重新套用審核再推送；推送被拒絕（別人先推了）就重來。
# 以前用 concurrency group 排隊，但 GitHub 同一組只保留一個等待中的執行，
# 第三個進來時會取消第二個，被取消的審核不會有任何提示。
set -euo pipefail
: "${DEAL_ID:?需要 DEAL_ID}" "${ACTION:?需要 ACTION}"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-${GITHUB_REF_NAME:-main}}"
git config user.name >/dev/null 2>&1 || git config user.name "deal-radar-bot"
git config user.email >/dev/null 2>&1 || git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

for attempt in 1 2 3 4 5 6 7 8; do
  git fetch -q "$REMOTE" "$BRANCH"
  git reset -q --hard "$REMOTE/$BRANCH"
  # 找不到這條優惠（已被核實、退回或被重新提取取代）會以非 0 結束，不重試
  node scripts/review.mjs
  node scripts/build-dashboards.mjs
  git add data dashboards
  if git diff --cached --quiet; then echo "沒有變更"; exit 0; fi
  git commit -q -m "review: $ACTION $DEAL_ID"
  if git push -q "$REMOTE" "HEAD:$BRANCH"; then echo "已推送（第 $attempt 次嘗試）"; exit 0; fi
  echo "推送被拒絕（別人先推了），在最新資料上重新套用…"
  sleep $(( (RANDOM % 4) + 2 ))
done
echo "重試多次仍無法推送" >&2
exit 1
