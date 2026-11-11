#!/usr/bin/env node
/**
 * GLOBAL DEAL RADAR 掃描器（GitHub Actions 版）
 * 掃描邏輯與 Worker 共用 worker/src/core.mjs：
 *   1. 擷取 data/sources.json 裡的官方來源頁面，用內容雜湊偵測變更
 *   2. 過期歸檔、重複優惠去重
 *   3. 有設 LLM_API_KEY 時，把變更的頁面交給 LLM 提取草稿（一律 status=pending，待人工核實）
 *   4. 有設 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 時，有新草稿、疑似失效、即將截止就推播
 *   5. 產出 data/last-run.json：掃描報告 + 待核實佇列（needsReview）
 * 沒設金鑰的功能自動停用，不影響其餘流程。
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {scanCore} from '../worker/src/core.mjs';
import {notifyScan} from '../worker/src/notify.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const readJson = (file, fallback) => {
  const p = path.join(dataDir, file);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
};
const writeJson = (file, value) => {
  const p = path.join(dataDir, file);
  fs.mkdirSync(path.dirname(p), {recursive: true});
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n');
};

const result = await scanCore({
  sources: readJson('sources.json', []),
  state: readJson('state.json', {sources: {}, lastRun: null}),
  deals: readJson('deals.json', []),
  archive: readJson('archive.json', [])
}, {llmApiKey: process.env.LLM_API_KEY});
result.lastRun.notification = await notifyScan(result, process.env);

writeJson('last-run.json', result.lastRun);
writeJson('state.json', result.state);
writeJson('deals.json', result.deals);
writeJson('archive.json', result.archive);

const s = result.lastRun.summary;
const ai = result.lastRun.aiExtraction;
console.log('[deal-radar] ' + result.lastRun.at + ' sources=' + s.sourcesChecked + ' changed=' + s.changed + ' failed=' + s.fetchFailed +
  ' activeDeals=' + s.activeDeals + ' pending=' + s.pending + ' archived=' + s.archived +
  ' ai=' + (ai.noKey ? 'off' : ai.extracted + '/' + ai.attempted) + ' notify=' + (result.lastRun.notification.sent ? 'sent' : 'skip'));
if (ai.errors.length) console.log('[deal-radar] ai errors: ' + ai.errors.join(' | '));
if (ai.warnings && ai.warnings.length) console.log('[deal-radar] ai warnings: ' + ai.warnings.join(' | '));
if (result.lastRun.notification.error) console.log('[deal-radar] notify error: ' + result.lastRun.notification.error);
