#!/usr/bin/env node
/**
 * GLOBAL DEAL HUNTER 看板生成器
 * 从 data/deals.json 与 data/archive.json 重建 dashboards/ 下的看板文件。
 * 由 .github/workflows/deal-hunter.yml 在每轮扫描后调用；也可手动运行：node scripts/build-dashboards.mjs
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

const CATEGORY_LABEL = {ai: 'AI 工具', crypto: 'Crypto', banking: '海外银行/卡', 'vps-cloud': 'VPS/云服务', software: '软件/数字服务', other: '其他'};

function fmtValue(d) {
  const v = d.value || {};
  if (v.valueTWD) return '约 TWD ' + Number(v.valueTWD).toLocaleString('en-US');
  if (v.type === 'free') return '免费（价值视使用而定）';
  return v.note || '待评估';
}
function fmtEnd(d) {
  if (d.ongoing === true) return '长期活动';
  return d.endDate || '未知';
}
function cell(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\|/g, '，').replace(/\r?\n/g, ' ');
}
function row(d) {
  return '| [' + cell(d.name) + '](' + d.officialUrl + ') | ' + (CATEGORY_LABEL[d.category] || d.category) + ' | ' + cell(String(d.summary || '').slice(0, 70)) + ' | ' + cell(fmtValue(d)) + ' | ' + cell(fmtEnd(d)) + ' | ' + (d.status === 'verified' ? '已核实' : '待核实') + ' |';
}
const HEAD = ['| 活动名称 | 类别 | 优惠内容 | 价值 | 截止 | 状态 |', '|---|---|---|---|---|---|'];
function table(rows) {
  if (!rows.length) return ['本专区目前没有符合条件的条目。', ''];
  return HEAD.concat(rows);
}
function note() {
  return ['> 本文件由 scripts/build-dashboards.mjs 自动生成，数据来源 data/deals.json。', '> 生成时间：' + at + '（UTC）。手动编辑会被下一轮覆盖，要改内容请改数据文件。', ''];
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

writeDash('01-today.md', 'A. 今日最新优惠', table(recent.map(row)));
writeDash('02-high-value.md', 'B. 高价值优惠排行榜', table(highValue.map(row)));
writeDash('03-ai-tools.md', 'C. AI 工具免费与折扣专区', table(byCategory('ai').map(row)));
writeDash('04-crypto.md', 'D. Crypto 空投与积分专区', table(byCategory('crypto').map(row)));
writeDash('05-banking-cards.md', 'E. 海外银行与银行卡优惠', table(byCategory('banking').map(row)));
writeDash('06-vps-cloud.md', 'F. VPS 及云服务专区', table(byCategory('vps-cloud').map(row)));
writeDash('09-software.md', 'I. 软件与数字服务专区', table(byCategory('software').map(row)));
writeDash('07-ending-soon.md', 'G. 即将截止的活动（14 天内）', table(endingSoon.map(row)));
const archiveRows = archive.length
  ? ['| 活动名称 | 类别 | 归档原因 | 归档时间 |', '|---|---|---|---|'].concat(archive.map(d => '| [' + cell(d.name) + '](' + (d.officialUrl || '') + ') | ' + (CATEGORY_LABEL[d.category] || d.category) + ' | ' + cell(d.archiveReason) + ' | ' + cell(d.archivedAt) + ' |'))
  : ['归档目前为空。', ''];
writeDash('08-archive.md', 'H. 已结束活动档案', archiveRows);

console.log('[deal-hunter] dashboards rebuilt: ' + at);
