# GLOBAL DEAL HUNTER｜全球羊毛情报中心

7x24 运行的全球优惠情报系统：自动盯官方来源、发现变更、去重、归档过期活动、重建看板。

原则：不编造优惠。条目只来自官方页面或可信来源，无法核实的标「待核实」，没有官方数字的地方留空，不硬填。

## 看板

| 模块 | 看板 | 内容 |
|---|---|---|
| A | dashboards/01-today.md | 今日最新优惠（最近 48 小时新增或验证） |
| B | dashboards/02-high-value.md | 高价值优惠排行榜（按估算价值排序） |
| C | dashboards/03-ai-tools.md | AI 工具免费与折扣专区 |
| D | dashboards/04-crypto.md | Crypto 空投与积分专区 |
| E | dashboards/05-banking-cards.md | 海外银行与银行卡优惠 |
| F | dashboards/06-vps-cloud.md | VPS 及云服务专区 |
| G | dashboards/07-ending-soon.md | 即将截止的活动（14 天内） |
| H | dashboards/08-archive.md | 已结束活动档案 |
| I | dashboards/09-software.md | 软件与数字服务专区（采集范围第 6 类独立成区） |

## 仓库结构

- data/deals.json：优惠数据库，唯一事实来源，格式见 docs/SCHEMA.md
- data/sources.json：监控来源清单（只收官方页面），可随时加来源
- data/last-run.json：最近一次扫描报告，含待核实队列
- data/archive.json：过期与重复条目归档
- scripts/scan.mjs：扫描器（抓取、哈希变更侦测、去重、过期归档）
- scripts/build-dashboards.mjs：看板生成器
- .github/workflows/deal-hunter.yml：每 2 小时的定时任务
- docs/RUNBOOK.md：怎么加来源、怎么核实、哪些自动化要另外配置

## 当前收录

首批 3 条已核实条目：Oracle Cloud 免费层、Google Cloud 免费试用、GitHub 学生包，都是 2026-11-10 开官方页面核对过的。Crypto、银行卡、AI 订阅专区目前为空，等扫描与核实流程填充。

## 自动化现状（如实说明）

已经能跑的：定时扫描、官方页面变更侦测、疑似失效侦测、重复优惠去重、过期自动归档、看板自动重建、扫描报告与验证时间记录。

要额外配置才有的：AI 自动提取优惠字段（需要配 LLM API 金钥）、推送通知（需要 Telegram Bot Token 或邮件服务），都写在 docs/RUNBOOK.md，当前版本不假装已经实现。

## 快速上手

1. 合并本 PR 后到 Actions 页确认 Deal Hunter Scan 出现，手动 Run workflow 一次验证。
2. 想加监控来源：编辑 data/sources.json。
3. 想加优惠条目：按 docs/SCHEMA.md 写进 data/deals.json，下一轮扫描会自动整理看板。
