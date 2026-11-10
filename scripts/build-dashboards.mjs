
#!/usr/bin/env node
/**
 * GLOBAL DEAL RADAR 看板產生器
 * 從 data/deals.json 與 data/archive.json 重建 dashboards/ 下的看板檔案。
 * 由 .github/workflows/deal-hunter.yml 在每輪掃描後呼叫；也可手動執行：node scripts/build-dashboards.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const dashDir = path.join(root, 'dashboards');
fs.mkdirSync(dashDir, {recursive: true});

const readJson = (file, fallback) => {
  const p = path.join(dataDir, file);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
};

const deals = readJson('deals.json', []);
const archive = readJson('archive.json', []);
const state = readJson('state.json', {});
const at = state.lastRun || new Date().toISOString();
const today = at.slice(0, 10);

const CATEGORY_LABEL = {ai: 'AI 工具', crypto: 'Crypto', banking: '海外銀行/卡', 'vps-cloud': 'VPS/雲服務', software: '軟體/數位服務', other: '其他'};

function fmtValue(d) {
  const v = d.value || {};
  if (v.valueTWD) return '約 TWD ' + Number(v.valueTWD).toLocaleString('en-US');
  if (v.type === 'free') return '免費（價值視使用而定）';
  return v.note || '待評估';
}
function fmtEnd(d) {
  if (d.ongoing === true) return '長期活動';
  return d.endDate || '未知';
}
function cell(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\|/g, '，').replace(/\r?\n/g, ' ');
}
function row(d) {
  return '| [' + cell(d.name) + '](' + d.officialUrl + ') | ' + (CATEGORY_LABEL[d.category] || d.category) + ' | ' + cell(String(d.summary || '').slice(0, 70)) + ' | ' + cell(fmtValue(d)) + ' | ' + cell(fmtEnd(d)) + ' | ' + (d.status === 'verified' ? '已核實' : '待核實') + ' |';
}
const HEAD = ['| 活動名稱 | 類別 | 優惠內容 | 價值 | 截止 | 狀態 |', '|---|---|---|---|---|---|'];
function table(rows) {
  if (!rows.length) return ['本專區目前沒有符合條件的條目。', ''];
  return HEAD.concat(rows);
}
function note() {
  return ['> 本檔案由 scripts/build-dashboards.mjs 自動產生，資料來源 data/deals.json。', '> 產生時間：' + at + '（UTC）。手動編輯會被下一輪覆蓋，要改內容請改資料檔案。', ''];
}
function byCategory(cat) { return deals.filter(d => d.category === cat && d.status !== 'example'); }
const daysAgoISO = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const daysAheadISO = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const active = deals.filter(d => d.status !== 'example');
const recent = active.filter(d => d.lastVerified && d.lastVerified >= daysAgoISO(2));
const highValue = active.slice().sort((a, b) => (b.value && b.value.valueTWD ? b.value.valueTWD : -1) - (a.value && a.value.valueTWD ? a.value.valueTWD : -1));
const endingSoon = active.filter(d => d.endDate && d.endDate >= today && d.endDate <= daysAheadISO(14) && d.ongoing !== true);

function writeDash(file, title, lines) {
  const content = ['# ' + title].concat(note(), lines).join('
') + '
';
  fs.writeFileSync(path.join(dashDir, file), content, 'utf8');
}

writeDash('01-today.md', 'A. 今日最新優惠', table(recent.map(row)));
writeDash('02-high-value.md', 'B. 高價值優惠排行榜', table(highValue.map(row)));
writeDash('03-ai-tools.md', 'C. AI 工具免費與折扣專區', table(byCategory('ai').map(row)));
writeDash('04-crypto.md', 'D. Crypto 空投與積分專區', table(byCategory('crypto').map(row)));
writeDash('05-banking-cards.md', 'E. 海外銀行與銀行卡優惠', table(byCategory('banking').map(row)));
writeDash('06-vps-cloud.md', 'F. VPS 及雲服務專區', table(byCategory('vps-cloud').map(row)));
writeDash('09-software.md', 'I. 軟體與數位服務專區', table(byCategory('software').map(row)));
writeDash('07-ending-soon.md', 'G. 即將截止的活動（14 天內）', table(endingSoon.map(row)));
const archiveRows = archive.length
  ? ['| 活動名稱 | 類別 | 歸檔原因 | 歸檔時間 |', '|---|---|---|---|'].concat(archive.map(d => '| [' + cell(d.name) + '](' + (d.officialUrl || '') + ') | ' + (CATEGORY_LABEL[d.category] || d.category) + ' | ' + cell(d.archiveReason) + ' | ' + cell(d.archivedAt) + ' |'))
  : ['歸檔目前為空。', ''];
writeDash('08-archive.md', 'H. 已結束活動檔案', archiveRows);

console.log('[deal-radar] dashboards rebuilt: ' + at);
