#!/usr/bin/env node
/**
 * GLOBAL DEAL HUNTER 扫描器 v1
 * 职责：
 *   1. 抓取 data/sources.json 里的官方来源页面
 *   2. 用内容哈希侦测页面变更（去重靠 deals 的 名称+官方链接 键）
 *   3. 把已过截止日期或重复的优惠移入 data/archive.json
 *   4. 产出 data/last-run.json：扫描报告 + 待核实队列（needsReview）
 * 边界（如实说明）：
 *   本脚本不做 AI 内容提取，也不会自动生成新优惠条目。
 *   页面有变更时进入待核实队列，由人工或后续接入的 LLM 步骤确认后写入 deals.json。
 *   如何接入 LLM 见 docs/RUNBOOK.md。
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
const UA = 'Mozilla/5.0 (compatible; DealHunterBot/1.0; +https://github.com/finrod-chen/global-banefits)';

const sources = readJson('sources.json', []);
const state = readJson('state.json', {sources: {}, lastRun: null});
const deals = readJson('deals.json', []);
const archive = readJson('archive.json', []);

// 1. 抓取与变更侦测
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
      // 关注关键词全部消失：页面可能下线或活动结束，标记疑似失效
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

// 2. 过期归档 + 重复优惠去重
const seen = new Map();
const keep = [];
for (const deal of deals) {
  if (deal.status === 'example') { keep.push(deal); continue; } // 示例条目不参与归档与去重
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

// 3. 写回
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
console.log('[deal-hunter] ' + nowISO + ' sources=' + results.length + ' changed=' + changedCount + ' activeDeals=' + keep.length + ' archived=' + archive.length);
