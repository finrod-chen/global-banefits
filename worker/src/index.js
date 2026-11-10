/**
 * GLOBAL DEAL RADAR｜全球好康情報中心 - Cloudflare Worker（看板）
 *
 * 資料只有一份：GitHub repo 的 data/。掃描、AI 提取、通知都在 GitHub Actions
 * （.github/workflows/deal-hunter.yml），Worker 只負責把 repo 的資料畫成看板。
 *
 *   GET  /                       看板網頁
 *   GET  /api/deals              目前有效優惠（data/deals.json）
 *   GET  /api/archive            已結束/退回的條目（data/archive.json）
 *   GET  /api/last-run           最近一次掃描報告（data/last-run.json）
 *   GET  /healthz                健康檢查
 *   POST /api/scan               觸發 Actions 立即掃描（需 ADMIN_TOKEN 與 GITHUB_TOKEN）
 *   POST /api/deals/:id/verify   觸發 Actions 核實這條草稿，body 可帶 {"valueTWD": 數字}
 *   POST /api/deals/:id/reject   觸發 Actions 退回這條草稿並歸檔
 *
 * 讀資料：repo 是公開的，直接讀 raw.githubusercontent.com，不需要金鑰。結果在記憶體快取 60 秒；
 * 請求網址帶時間戳（15 秒一格）避開 raw 約 5 分鐘的快取，所以 Actions 提交後看板最慢約 1 分鐘更新。
 * 在網址加 ?fresh=1 會略過記憶體快取（距上次讀取至少 5 秒），看板的操作按鈕用它輪詢結果。
 * 讀不到時沿用上一份。
 *
 * 變數（Worker 的 Settings → Variables and Secrets；wrangler.toml 的 [vars] 有預設值）：
 *   REPO_SLUG、REPO_BRANCH   讀哪個 repo 與分支（預設 finrod-chen/global-banefits、main）
 *   ADMIN_TOKEN              看板管理模式與 POST 端點的密碼
 *   GITHUB_TOKEN             Secret。fine-grained token，只給這個 repo 的 Actions: Read and write，
 *                            用來讓看板按鈕觸發 workflow。沒設的話按鈕會提示改去 GitHub 手動執行。
 */

import {dashboardHtml} from './dashboard.js';

const FILES = {deals: 'data/deals.json', archive: 'data/archive.json', lastRun: 'data/last-run.json'};
const TTL_MS = 60 * 1000;
const FRESH_MIN_MS = 5 * 1000;
let memo = null; // {at, data}：同一個 isolate 內重複使用

function repoOf(env) {
  return {slug: env.REPO_SLUG || 'finrod-chen/global-banefits', branch: env.REPO_BRANCH || 'main'};
}

async function readRepoJson(env, path, fallback) {
  const {slug, branch} = repoOf(env);
  // 時間戳讓每 15 秒換一個網址，避開 raw.githubusercontent.com 約 5 分鐘的快取，否則審核完要等很久才看得到
  const res = await fetch('https://raw.githubusercontent.com/' + slug + '/' + branch + '/' + path + '?t=' + Math.floor(Date.now() / 15000), {
    headers: {'User-Agent': 'deal-radar-dashboard'},
    signal: AbortSignal.timeout(10000)
  });
  if (res.status === 404) return fallback;
  if (!res.ok) throw new Error(path + ' HTTP ' + res.status);
  return JSON.parse(await res.text());
}

async function loadData(env, fresh) {
  if (memo && Date.now() - memo.at < (fresh ? FRESH_MIN_MS : TTL_MS)) return memo.data;
  try {
    const [deals, archive, lastRun] = await Promise.all([
      readRepoJson(env, FILES.deals, null),
      readRepoJson(env, FILES.archive, []),
      readRepoJson(env, FILES.lastRun, null)
    ]);
    if (!Array.isArray(deals)) throw new Error('repo 裡沒有 ' + FILES.deals + ' 或格式不對');
    memo = {at: Date.now(), data: {deals, archive: Array.isArray(archive) ? archive : [], lastRun}};
    return memo.data;
  } catch (error) {
    if (memo) return Object.assign({}, memo.data, {stale: true});
    throw error;
  }
}

function json(value, status) {
  return new Response(JSON.stringify(value, null, 2), {status: status || 200, headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}});
}

// ---------- 管理：去觸發 GitHub Actions ----------

// 固定時間比對，避免從回應時間猜出 token
function tokenMatches(given, expected) {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
function adminError(request, env) {
  if (!env.ADMIN_TOKEN) return json({error: '未設定 ADMIN_TOKEN，管理功能停用'}, 503);
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return tokenMatches(given, env.ADMIN_TOKEN) ? null : json({error: 'token 不正確'}, 401);
}

async function dispatchWorkflow(env, workflow, inputs) {
  const {slug, branch} = repoOf(env);
  if (!env.GITHUB_TOKEN) {
    return json({error: '未設定 GITHUB_TOKEN，無法從看板觸發。請到 https://github.com/' + slug + '/actions/workflows/' + workflow + ' 按 Run workflow 手動執行。'}, 503);
  }
  const res = await fetch('https://api.github.com/repos/' + slug + '/actions/workflows/' + workflow + '/dispatches', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'deal-radar-dashboard',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(inputs ? {ref: branch, inputs} : {ref: branch}),
    signal: AbortSignal.timeout(15000)
  });
  if (res.status === 204) {
    memo = null; // 下次看板讀取時重新抓
    return json({ok: true, message: '已送出，處理完成後這頁會自動更新。'});
  }
  const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
  return json({error: 'GitHub 回應 HTTP ' + res.status + (detail ? '：' + detail : '')}, 502);
}

async function handleAdmin(request, env, url) {
  const denied = adminError(request, env);
  if (denied) return denied;
  if (url.pathname === '/api/scan') return dispatchWorkflow(env, 'deal-hunter.yml', null);
  const m = url.pathname.match(/^\/api\/deals\/([^/]+)\/(verify|reject)$/);
  if (!m) return json({error: 'Not found'}, 404);
  const id = decodeURIComponent(m[1]);
  let body = null;
  try { body = await request.json(); } catch (e) { body = null; }
  let valueTWD = '';
  if (m[2] === 'verify' && body && body.valueTWD !== undefined && body.valueTWD !== null && body.valueTWD !== '') {
    const n = Number(body.valueTWD);
    if (!Number.isFinite(n) || n <= 0) return json({error: 'valueTWD 必須是大於 0 的數字'}, 400);
    valueTWD = String(Math.round(n));
  }
  let data;
  try { data = await loadData(env); } catch (error) { return json({error: '讀不到 repo 資料：' + error.message}, 502); }
  const deal = data.deals.find(d => d.id === id);
  if (!deal) return json({error: '找不到這條優惠（可能已被核實、退回或重新提取取代）'}, 404);
  if (deal.status === 'verified') return json({error: '這條已經是已核實'}, 409);
  return dispatchWorkflow(env, 'review-deal.yml', {id, action: m[2], value_twd: valueTWD});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST') return handleAdmin(request, env, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', {status: 405});
    if (url.pathname === '/healthz') return new Response('ok');
    const known = ['/', '/index.html', '/api/deals', '/api/archive', '/api/last-run'];
    if (known.indexOf(url.pathname) < 0) return new Response('Not found', {status: 404});
    let data;
    try {
      data = await loadData(env, url.searchParams.get('fresh') === '1');
    } catch (error) {
      const message = '讀不到 GitHub repo 的資料：' + error.message;
      if (url.pathname.indexOf('/api/') === 0) return json({error: message}, 502);
      return new Response(message, {status: 502, headers: {'content-type': 'text/plain; charset=utf-8'}});
    }
    if (url.pathname === '/api/deals') return json(data.deals);
    if (url.pathname === '/api/archive') return json(data.archive);
    if (url.pathname === '/api/last-run') return json(data.lastRun);
    return new Response(dashboardHtml(data.deals, data.lastRun, data.archive, {repo: repoOf(env).slug, stale: !!data.stale}), {headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'}});
  }
};
