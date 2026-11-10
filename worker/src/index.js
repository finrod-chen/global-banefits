/**
 * GLOBAL DEAL RADAR｜全球好康情報中心 - Cloudflare Workers 版
 *
 * scheduled：Cron Triggers 每 2 小時掃描一次（見 wrangler.toml）
 * fetch：GET / 看板網頁；GET /api/deals、GET /api/last-run 回 JSON；GET /healthz 健康檢查
 *
 * 資料放在 KV namespace DEAL_DATA，鍵值：sources / state / deals / archive / last-run
 * 部署時由 GitHub Actions 從 repo 的 data/ 種子化：sources 每次部署覆蓋（跟 repo 同步），
 * deals / state / archive / last-run 只在不存在時種入（不覆蓋 Worker 自己掃出來的進度）。
 *
 * 如實說明：
 * - KV 這份資料與 repo（GitHub Actions 版）是各自獨立的副本，不會自動互相同步；
 *   要雙向同步需再接 GitHub API 與另一支 token，目前版本不含。
 * - 本版不做 AI 提取，行為與 scripts/scan.mjs 相同：頁面級變更偵測 + 待核實佇列。
 */

const KEY = {sources: 'sources', state: 'state', deals: 'deals', archive: 'archive', lastrun: 'last-run'};
const UA = 'Mozilla/5.0 (compatible; DealRadarWorker/1.0; +https://github.com/finrod-chen/global-banefits)';
const CATEGORY_LABEL = {ai: 'AI 工具', crypto: 'Crypto', banking: '海外銀行/卡', 'vps-cloud': 'VPS/雲服務', software: '軟體/數位服務', other: '其他'};

async function getJson(env, key, fallback) {
  const raw = await env.DEAL_DATA.get(key);
  if (raw === null || raw === undefined) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}
async function putJson(env, key, value) {
  await env.DEAL_DATA.put(key, JSON.stringify(value, null, 2));
}

async function sha256Hex16(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

const daysAgoISO = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const daysAheadISO = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

export async function runScan(env) {
  const nowISO = new Date().toISOString();
  const today = nowISO.slice(0, 10);
  const sources = await getJson(env, KEY.sources, []);
  const state = await getJson(env, KEY.state, {sources: {}, lastRun: null});
  const deals = await getJson(env, KEY.deals, []);
  const archive = await getJson(env, KEY.archive, []);

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
      entry.hash = await sha256Hex16(body);
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
    if (deal.status === 'example') { keep.push(deal); continue; }
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
  const lastRun = {
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
  };
  await putJson(env, KEY.state, state);
  await putJson(env, KEY.deals, keep);
  await putJson(env, KEY.archive, archive);
  await putJson(env, KEY.lastrun, lastRun);
  return lastRun;
}

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
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
function rowHtml(d) {
  return '<tr><td><a href="' + esc(d.officialUrl) + '">' + esc(d.name) + '</a></td><td>' + esc(CATEGORY_LABEL[d.category] || d.category) + '</td><td>' + esc(String(d.summary || '').slice(0, 90)) + '</td><td>' + esc(fmtValue(d)) + '</td><td>' + esc(fmtEnd(d)) + '</td><td>' + (d.status === 'verified' ? '已核實' : '待核實') + '</td></tr>';
}
function sectionHtml(title, deals_, emptyText) {
  if (!deals_.length) return '<h2>' + esc(title) + '</h2><p class="empty">' + esc(emptyText) + '</p>';
  return '<h2>' + esc(title) + '</h2><table><tr><th>活動名稱</th><th>類別</th><th>優惠內容</th><th>價值</th><th>截止</th><th>狀態</th></tr>' + deals_.map(rowHtml).join('') + '</table>';
}

function dashboardHtml(deals, lastRun) {
  const active = deals.filter(d => d.status !== 'example');
  const recent = active.filter(d => d.lastVerified && d.lastVerified >= daysAgoISO(2));
  const highValue = active.slice().sort((a, b) => (b.value && b.value.valueTWD ? b.value.valueTWD : -1) - (a.value && a.value.valueTWD ? a.value.valueTWD : -1));
  const today = new Date().toISOString().slice(0, 10);
  const endingSoon = active.filter(d => d.endDate && d.endDate >= today && d.endDate <= daysAheadISO(14) && d.ongoing !== true);
  const byCat = cat => active.filter(d => d.category === cat);
  const at = lastRun && lastRun.at ? lastRun.at : new Date().toISOString();
  return [
    '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>GLOBAL DEAL RADAR｜全球好康情報中心</title>',
    '<style>body{font-family:system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#1f2328}h1{font-size:20px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #d0d7de;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f6f8fa}.empty{color:#656d76}.meta{color:#656d76;font-size:12px}a{color:#0969da}</style></head><body>',
    '<h1>GLOBAL DEAL RADAR｜全球好康情報中心</h1>',
    '<p class="meta">本頁由 Cloudflare Worker 即時渲染，資料在 KV，每 2 小時自動掃描。最近掃描：' + esc(at) + '（UTC）。JSON：<a href="/api/deals">/api/deals</a>、<a href="/api/last-run">/api/last-run</a></p>',
    '<p class="meta">原則：不編造優惠；無法核實的標「待核實」，沒有官方數字的地方留空。</p>',
    sectionHtml('A. 今日最新優惠（最近 48 小時）', recent, '本專區目前沒有符合條件的條目。'),
    sectionHtml('B. 高價值優惠排行榜', highValue, '本專區目前沒有符合條件的條目。'),
    sectionHtml('C. AI 工具免費與折扣專區', byCat('ai'), '本專區目前沒有符合條件的條目。'),
    sectionHtml('D. Crypto 空投與積分專區', byCat('crypto'), '本專區目前沒有符合條件的條目。'),
    sectionHtml('E. 海外銀行與銀行卡優惠', byCat('banking'), '本專區目前沒有符合條件的條目。'),
    sectionHtml('F. VPS 及雲服務專區', byCat('vps-cloud'), '本專區目前沒有符合條件的條目。'),
    sectionHtml('I. 軟體與數位服務專區', byCat('software'), '本專區目前沒有符合條件的條目。'),
    sectionHtml('G. 即將截止的活動（14 天內）', endingSoon, '本專區目前沒有符合條件的條目。'),
    '<p class="meta">H. 已結束活動檔案請看 repo 的 dashboards/08-archive.md（Worker 版不重複存檔案）。</p>',
    '</body></html>'
  ].join('');
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScan(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return new Response('ok');
    if (url.pathname === '/api/deals') {
      return new Response(JSON.stringify(await getJson(env, KEY.deals, []), null, 2), {headers: {"content-type": "application/json; charset=utf-8"}});
    }
    if (url.pathname === '/api/last-run') {
      return new Response(JSON.stringify(await getJson(env, KEY.lastrun, null), null, 2), {headers: {"content-type": "application/json; charset=utf-8"}});
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const deals = await getJson(env, KEY.deals, []);
      const lastRun = await getJson(env, KEY.lastrun, null);
      return new Response(dashboardHtml(deals, lastRun), {headers: {"content-type": "text/html; charset=utf-8"}});
    }
    return new Response('Not found', {status: 404});
  }
};
