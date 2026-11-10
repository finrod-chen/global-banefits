/**
 * GLOBAL DEAL RADAR｜全球好康情報中心 - Cloudflare Workers 版
 *
 * scheduled：Cron Triggers 每 2 小時掃描一次（見 wrangler.toml）
 * fetch：
 *   GET  /                       看板網頁
 *   GET  /api/deals              目前有效優惠
 *   GET  /api/archive            已結束/退回的條目
 *   GET  /api/last-run           最近一次掃描報告
 *   GET  /healthz                健康檢查
 *   POST /api/scan               立即掃描（需 ADMIN_TOKEN）
 *   POST /api/deals/:id/verify   核實通過，body 可帶 {"valueTWD": 數字}（需 ADMIN_TOKEN）
 *   POST /api/deals/:id/reject   退回並歸檔（需 ADMIN_TOKEN）
 *
 * 掃描邏輯在 core.mjs（與 GitHub Actions 版共用），通知在 notify.mjs，版面在 dashboard.js。
 * 資料放在 KV namespace DEAL_DATA，鍵值：sources / state / deals / archive / last-run
 *
 * 環境變數（都在 Worker 的 Settings → Variables and Secrets 設，沒設的功能自動停用）：
 *   LLM_API_KEY                           AI 提取草稿
 *   TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID  推播通知
 *   ADMIN_TOKEN                           看板管理模式與上面三個 POST 端點
 *   DASHBOARD_URL                         通知訊息裡附的看板連結（選填）
 *
 * 如實說明：KV 這份資料與 repo（GitHub Actions 版）是各自獨立的副本，不會自動互相同步。
 */

import {dashboardHtml} from './dashboard.js';
import {scanCore, reviewDeal} from './core.mjs';
import {notifyScan} from './notify.mjs';

const KEY = {sources: 'sources', state: 'state', deals: 'deals', archive: 'archive', lastrun: 'last-run'};

async function getJson(env, key, fallback) {
  const raw = await env.DEAL_DATA.get(key);
  if (raw === null || raw === undefined) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}
async function putJson(env, key, value) {
  await env.DEAL_DATA.put(key, JSON.stringify(value, null, 2));
}
function json(value, status) {
  return new Response(JSON.stringify(value, null, 2), {status: status || 200, headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}});
}

export async function runScan(env) {
  const result = await scanCore({
    sources: await getJson(env, KEY.sources, []),
    state: await getJson(env, KEY.state, {sources: {}, lastRun: null}),
    deals: await getJson(env, KEY.deals, []),
    archive: await getJson(env, KEY.archive, [])
  }, {llmApiKey: env.LLM_API_KEY});
  result.lastRun.notification = await notifyScan(result, env);
  await putJson(env, KEY.state, result.state);
  await putJson(env, KEY.deals, result.deals);
  await putJson(env, KEY.archive, result.archive);
  await putJson(env, KEY.lastrun, result.lastRun);
  return result.lastRun;
}

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

async function handleAdmin(request, env, url) {
  const denied = adminError(request, env);
  if (denied) return denied;
  if (url.pathname === '/api/scan') return json(await runScan(env));
  const m = url.pathname.match(/^\/api\/deals\/([^/]+)\/(verify|reject)$/);
  if (!m) return json({error: 'Not found'}, 404);
  let patch = null;
  try { patch = await request.json(); } catch (e) { patch = null; }
  const deals = await getJson(env, KEY.deals, []);
  const archive = await getJson(env, KEY.archive, []);
  const deal = reviewDeal(deals, archive, decodeURIComponent(m[1]), m[2], patch);
  if (!deal) return json({error: '找不到這條優惠'}, 404);
  await putJson(env, KEY.deals, deals);
  if (m[2] === 'reject') await putJson(env, KEY.archive, archive);
  return json({ok: true, deal});
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScan(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST') return handleAdmin(request, env, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', {status: 405});
    if (url.pathname === '/healthz') return new Response('ok');
    if (url.pathname === '/api/deals') return json(await getJson(env, KEY.deals, []));
    if (url.pathname === '/api/archive') return json(await getJson(env, KEY.archive, []));
    if (url.pathname === '/api/last-run') return json(await getJson(env, KEY.lastrun, null));
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const deals = await getJson(env, KEY.deals, []);
      const lastRun = await getJson(env, KEY.lastrun, null);
      const archive = await getJson(env, KEY.archive, []);
      return new Response(dashboardHtml(deals, lastRun, archive), {headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'}});
    }
    return new Response('Not found', {status: 404});
  }
};
