
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

- data/deals.json：優惠資料庫，唯一事實來源，格式見 docs/SCHEMA.md
- data/sources.json：監控來源清單（只收官方頁面），可隨時加來源
- data/last-run.json：最近一次掃描報告，含待核實佇列
- data/archive.json：過期與重複條目歸檔
- worker/src/core.mjs：掃描核心（擷取、變更偵測、去重、過期歸檔、LLM 提取），GitHub Actions 與 Worker 共用
- scripts/scan.mjs：GitHub Actions 版掃描器（讀寫 data/，呼叫掃描核心與通知）
- scripts/build-dashboards.mjs：看板產生器
- .github/workflows/deal-hunter.yml：每 2 小時的定時任務
- worker/：Cloudflare Workers 線上版（cron 掃描 + KV + 即時看板網頁），見 worker/README.md
- docs/RUNBOOK.md：怎麼加來源、怎麼核實、哪些自動化要另外設定

## 目前收錄

首批 3 條已核實條目：Oracle Cloud 免費層、Google Cloud 免費試用、GitHub 學生包，都是 2026-11-10 開官方頁面核對過的。Crypto、銀行卡、AI 訂閱專區目前為空，等掃描與核實流程填充。

## 自動化現況（如實說明）

已經能跑的：定時掃描、官方頁面變更偵測、疑似失效偵測、重複優惠去重、過期自動歸檔、看板自動重建、掃描報告與驗證時間記錄。

設了金鑰就會啟用的：AI 自動提取優惠草稿（LLM_API_KEY）、Telegram 推播（TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID）、Worker 看板的管理模式（ADMIN_TOKEN）。沒設的功能自動停用。設定方式見 docs/RUNBOOK.md 與 worker/README.md。

AI 提取的結果一律是待核實草稿、不填價值數字，要人工對照官方頁面後才會標成已核實。

## 快速上手

1. 合併本 PR 後到 Actions 頁確認 Deal Radar Scan 與 Deploy Deal Radar Worker 出現，手動 Run 一次驗證。
2. 想加監控來源：編輯 data/sources.json。
3. 想加優惠條目：按 docs/SCHEMA.md 寫進 data/deals.json，下一輪掃描會自動整理看板。
