
# 維運手冊（RUNBOOK）

## 日常流程

1. 掃描：GitHub Actions 每 2 小時跑一次 scripts/scan.mjs，跑完自動執行 scripts/build-dashboards.mjs 重建看板並提交。
2. 待核實佇列：打開 data/last-run.json 看 needsReview 欄位，裡面是本輪發生變更的來源（content-changed / first-seen / suspect-expired / fetch-failed）。
3. 人工核實：點開對應來源頁面，確認有新活動後，按 docs/SCHEMA.md 的格式把新條目寫進 data/deals.json（status 先填 pending，核實完改 verified）。
4. 下一輪掃描會自動：去重（同名 + 同官方連結）、歸檔過期條目、重建看板。

## 新增監控來源

編輯 data/sources.json 加一條：id（唯一英文識別）、category、name、url（只用官方網域）、watchKeywords（關注關鍵字陣列；掃描時這些關鍵字全部從頁面消失會標記 suspect-expired）、enabled（設為 false 可暫時停用）。

## 已實作的自動化

- 每 2 小時定時掃描（GitHub Actions cron；GitHub 排程可能有 10 到 30 分鐘延遲）
- 官方頁面雜湊比對、變更偵測、疑似失效偵測（關鍵字消失）
- 重複優惠去重、過期自動歸檔
- 看板自動重建（今日、排行榜、分類、即將截止、檔案）
- 掃描報告與每條優惠的最後驗證時間記錄

## 尚未實作、需要額外設定的（不要誤以為已經在跑）

- AI 自動提取優惠欄位：需要給倉庫設一個 LLM API 金鑰（Settings → Secrets and variables → Actions，例如 LLM_API_KEY），並在 scripts/scan.mjs 的待核實環節接入呼叫。目前版本只做頁面級變更偵測。
- 推播通知（Telegram / 郵件 / Slack）：需要對應服務的 Bot Token 或 SMTP 設定，同樣是加 Secret 後在 workflow 裡加一步。目前版本不含。
- 地區限制與資格條件的自動識別：依賴上面的 LLM 步驟，目前靠人工核實。
- Actions 啟用：合併後在倉庫 Actions 頁確認 Deal Radar Scan 出現；如果排程沒跑，檢查 Settings → Actions → General 是否允許，並手動 Run workflow 驗證。GitHub 會在倉庫 60 天無活動時自動暫停排程，有新提交就會重置計時。

## 本機執行

- node scripts/scan.mjs
- node scripts/build-dashboards.mjs
- 需要 Node 18 以上（用了內建 fetch）
