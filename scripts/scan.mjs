
#!/usr/bin/env node
/**
 * GLOBAL DEAL RADAR 掃描器 v1
 * 職責：
 *   1. 擷取 data/sources.json 裡的官方來源頁面
 *   2. 用內容雜湊偵測頁面變更（去重靠 deals 的 名稱+官方連結 鍵）
 *   3. 把已過截止日期或重複的優惠移入 data/archive.json
 *   4. 產出 data/last-run.json：掃描報告 + 待核實佇列（needsReview）
 * 邊界（如實說明）：
 *   本腳本不做 AI 內容提取，也不會自動產生新優惠條目。
 *   頁面有變更時進入待核實佇列，由人工或後續接入的 LLM 步驟確認後寫入 deals.json。
 *   如何接入 LLM 見 docs/RUNBOOK.md。
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

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
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '
');
};

const nowISO = new Date().toISOString();
const today = nowISO.slice(0, 10);
const UA = 'Mozilla/5.0 (compatible; DealRadarBot/1.0; +https://github.com/finrod-chen/global-banefits)';

const sources = readJson('sources.json', []);
const state = readJson('state.json', {sources: {}, lastRun: null});
const deals = readJson('deals.json', []);
const archive = readJson('archive.json', []);

// 1. 擷取與變更偵測
const results = [];
for (const source of sources) {
  if (source.enabled === false) continue;
  const entry = {id: source.id, category: source.category, name: source.name, url: source.url, at: nowISO};
  try {
    const res = await fetch(source.url, {headers: {'User-Agent': UA, 'Accept-Language': 'en'}, redirect: 'follow'});
    const body = await res.text();
    entry.httpStatus = res.status;
    entry.bytes = body.length;
    entry.hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
    entry.keywordHits = (source.watchKeywords || []).filter(k => body.toLowerCase().includes(String(k).toLowerCase()));
    const previous = state.sources ? state.sources[source.id] : null;
    if (!previous) {
      entry.change = 'first-seen';
    } else if (previous.hash !== entry.hash) {
      entry.change = 'content-changed';
      // 關注關鍵字全部消失：頁面可能下線或活動結束，標記疑似失效
      if ((source.watchKeywords || []).length > 0 && entry.keywordHits.length === 0) {
        entry.change = 'content-changed-suspect-expired';
      }
    } else {
      entry.change = 'unchanged';
    }
  } catch (error) {
    entry.httpStatus = 'error';
    entry.error = String(error && error.message ? error.message : error);
    entry.change = 'fetch-failed';
  }
  results.push(entry);
  state.sources = state.sources || {};
  state.sources[source.id] = {hash: entry.hash ? entry.hash : null, httpStatus: entry.httpStatus, at: nowISO};
}

// 2. 過期歸檔 + 重複優惠去重
const seen = new Map();
const keep = [];
for (const deal of deals) {
  if (deal.status === 'example') { keep.push(deal); continue; } // 範例條目不參與歸檔與去重
  const key = String(deal.name || '').toLowerCase().trim() + '|' + String(deal.officialUrl || '').replace(/\/+$/, '');
  if (seen.has(key)) {
    archive.push(Object.assign({}, deal, {status: 'duplicate', archivedAt: nowISO, archiveReason: 'duplicate of ' + seen.get(key)}));
    continue;
  }
  seen.set(key, deal.id);
  if (deal.endDate && deal.endDate < today && deal.ongoing !== true) {
    archive.push(Object.assign({}, deal, {status: 'expired', archivedAt: nowISO, archiveReason: 'endDate passed'}));
    continue;
  }
  keep.push(deal);
}

// 3. 寫回
writeJson('last-run.json', {
  at: nowISO,
  summary: {
    sourcesChecked: results.length,
    changed: results.filter(r => String(r.change).indexOf('content-changed') === 0).length,
    fetchFailed: results.filter(r => r.change === 'fetch-failed').length,
    activeDeals: keep.length,
    archived: archive.length
  },
  needsReview: results.filter(r => r.change !== 'unchanged'),
  results
});
writeJson('state.json', Object.assign({}, state, {lastRun: nowISO}));
writeJson('deals.json', keep);
writeJson('archive.json', archive);

const changedCount = results.filter(r => String(r.change).indexOf('content-changed') === 0).length;
console.log('[deal-radar] ' + nowISO + ' sources=' + results.length + ' changed=' + changedCount + ' activeDeals=' + keep.length + ' archived=' + archive.length);
