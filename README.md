
# GLOBAL DEAL RADAR｜全球好康情報中心

7x24 運作的全球優惠情報系統：自動盯官方來源、發現變更、去重、歸檔過期活動、重建看板。

原則：不編造優惠。條目只來自官方頁面或可信來源，無法核實的標「待核實」，沒有官方數字的地方留空，不硬填。

## 看板

| 模組 | 看板 | 內容 |
|---|---|---|
| A | dashboards/01-today.md | 今日最新優惠（最近 48 小時新增或驗證） |
| B | dashboards/02-high-value.md | 高價值優惠排行榜（按估算價值排序） |
| C | dashboards/03-ai-tools.md | AI 工具免費與折扣專區 |
| D | dashboards/04-crypto.md | Crypto 空投與積分專區 |
| E | dashboards/05-banking-cards.md | 海外銀行與銀行卡優惠 |
| F | dashboards/06-vps-cloud.md | VPS 及雲服務專區 |
| G | dashboards/07-ending-soon.md | 即將截止的活動（14 天內） |
| H | dashboards/08-archive.md | 已結束活動檔案 |
| I | dashboards/09-software.md | 軟體與數位服務專區（蒐集範圍第 6 類獨立成區） |

## 倉庫結構

- data/deals.json：優惠資料庫，唯一事實來源（看板也是讀這份），格式見 docs/SCHEMA.md
- data/sources.json：監控來源清單（只收官方頁面），可隨時加來源
- data/last-run.json：最近一次掃描報告，含待核實佇列
- data/archive.json：過期與重複條目歸檔
- worker/src/core.mjs：掃描核心（擷取、變更偵測、去重、過期歸檔、LLM 提取）與審核邏輯
- scripts/scan.mjs：掃描器（讀寫 data/，呼叫掃描核心與通知），由 GitHub Actions 執行
- scripts/review.mjs：人工審核一條草稿（核實通過或退回），由 Review Deal workflow 執行
- scripts/build-dashboards.mjs：看板產生器
- .github/workflows/deal-hunter.yml：每 2 小時的定時掃描
- .github/workflows/review-deal.yml：人工審核（Actions 頁手動執行，或從看板按鈕觸發）
- worker/：Cloudflare Worker 看板網頁，只讀 repo 的 data/ 來顯示，見 worker/README.md
- wrangler.toml：Worker 設定（放根目錄，Cloudflare 部署需要）
- docs/RUNBOOK.md：怎麼加來源、怎麼核實、哪些自動化要另外設定

## 目前收錄

首批 3 條已核實條目：Oracle Cloud 免費層、Google Cloud 免費試用、GitHub 學生包，都是 2026-11-10 開官方頁面核對過的。Crypto、銀行卡、AI 訂閱專區目前為空，等掃描與核實流程填充。

## 自動化現況（如實說明）

已經能跑的：定時掃描、官方頁面變更偵測、疑似失效偵測、重複優惠去重、過期自動歸檔、看板自動重建、掃描報告與驗證時間記錄。

設了金鑰就會啟用的：AI 自動提取優惠草稿（repo secret LLM_API_KEY）、Telegram 推播（repo secrets TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID）、看板上的核實與立即掃描按鈕（Worker 的 ADMIN_TOKEN 與 GITHUB_TOKEN）。沒設的功能自動停用。設定方式見 docs/RUNBOOK.md 與 worker/README.md。

AI 提取的結果一律是草稿。每條草稿會再做一次 AI 預審：LLM 為每個論點附上頁面原文引文，程式逐字比對引文是否真的在頁面上，並檢查數字、連結網域與截止日；全部通過才標「AI 預審通過」，同時給一個 AI 估值（頁面有明確金額就依固定匯率換算，否則是推測，兩者都標明）。

看板上有三種狀態：**已核實**（人工放行）、**AI 預審通過**（程式比對過原文，但沒有人看過）、**待核實**。只有人工放行才會變成已核實；放行時 AI 估值會帶進價值欄，你可以直接放行或修改。

## 快速上手

1. 到 Actions 頁確認 Deal Radar Scan 有在跑，沒有的話手動 Run 一次。
2. 想加監控來源：編輯 data/sources.json。
3. 想加優惠條目：按 docs/SCHEMA.md 寫進 data/deals.json，下一輪掃描會自動整理看板。
