# 运维手册（RUNBOOK）

## 日常流程

1. 扫描：GitHub Actions 每 2 小时跑一次 scripts/scan.mjs，跑完自动执行 scripts/build-dashboards.mjs 重建看板并提交。
2. 待核实队列：打开 data/last-run.json 看 needsReview 字段，里面是本轮发生变更的来源（content-changed / first-seen / suspect-expired / fetch-failed）。
3. 人工核实：点开对应来源页面，确认有新活动后，按 docs/SCHEMA.md 的格式把新条目写进 data/deals.json（status 先填 pending，核实完改 verified）。
4. 下一次扫描会自动：去重（同名 + 同官方链接）、归档过期条目、重建看板。

## 新增监控来源

编辑 data/sources.json 加一条：id（唯一英文标识）、category、name、url（只用官方域名）、watchKeywords（关注关键词数组；扫描时这些关键词全部从页面消失会标记 suspect-expired）、enabled（设为 false 可暂时停用）。

## 已实现的自动化

- 每 2 小时定时扫描（GitHub Actions cron；GitHub 调度可能有 10 到 30 分钟延迟）
- 官方页面哈希对比、变更侦测、疑似失效侦测（关键词消失）
- 重复优惠去重、过期自动归档
- 看板自动重建（今日、排行榜、分类、即将截止、档案）
- 扫描报告与每条优惠的最后验证时间记录

## 尚未实现、需要额外配置的（不要误以为已经在跑）

- AI 自动提取优惠字段：需要给仓库配一个 LLM API 金钥（Settings → Secrets and variables → Actions，例如 LLM_API_KEY），并在 scripts/scan.mjs 的待核实环节接入调用。当前版本只做页面级变更侦测。
- 推送通知（Telegram / 邮件 / Slack）：需要对应服务的 Bot Token 或 SMTP 配置，同样是加 Secret 后在 workflow 里加一步。当前版本不含。
- 地区限制与资格条件的自动识别：依赖上面的 LLM 步骤，当前靠人工核实。
- Actions 启用：合并后在仓库 Actions 页确认 Deal Hunter Scan 出现；如果排程没跑，检查 Settings → Actions → General 是否允许，并手动 Run workflow 验证。GitHub 会在仓库 60 天无活动时自动暂停排程，有新提交就会重置计时。

## 本地运行

- node scripts/scan.mjs
- node scripts/build-dashboards.mjs
- 需要 Node 18 以上（用了内置 fetch）
