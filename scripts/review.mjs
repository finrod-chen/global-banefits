#!/usr/bin/env node
/**
 * 人工審核一條優惠（由 .github/workflows/review-deal.yml 呼叫，也可以本機手動跑）
 *   DEAL_ID=<id> ACTION=verify|reject [VALUE_TWD=<數字>] node scripts/review.mjs
 * verify：status 改為 verified，更新核實日期，可順便填估算價值（新台幣）
 * reject：從 deals.json 移到 archive.json，狀態 rejected；之後 AI 提取不會再把同一條塞回來
 * 邏輯在 worker/src/core.mjs 的 reviewDeal，找不到這條會以非 0 結束。
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {reviewDeal} from '../worker/src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const readJson = (file, fallback) => {
  const p = path.join(dataDir, file);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
};
const writeJson = (file, value) => fs.writeFileSync(path.join(dataDir, file), JSON.stringify(value, null, 2) + '\n');

const id = process.env.DEAL_ID || '';
const action = process.env.ACTION || '';
if (!id || (action !== 'verify' && action !== 'reject')) {
  console.error('用法：DEAL_ID=<id> ACTION=verify|reject [VALUE_TWD=<數字>] node scripts/review.mjs');
  process.exit(2);
}
const deals = readJson('deals.json', []);
const archive = readJson('archive.json', []);
const result = reviewDeal(deals, archive, id, action, {valueTWD: process.env.VALUE_TWD});
if (!result) {
  console.error('找不到這條優惠：' + id + '（可能已被核實、退回或被重新提取取代）');
  process.exit(1);
}
writeJson('deals.json', deals);
if (action === 'reject') writeJson('archive.json', archive);
console.log('[review] ' + action + ' ' + id + ' → ' + result.status + (result.value && result.value.valueTWD ? ' valueTWD=' + result.value.valueTWD : ''));
