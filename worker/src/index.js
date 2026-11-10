
/**
 * GLOBAL DEAL RADAR｜全球好康情報中心 - Cloudflare Workers 版
 *
 * scheduled：Cron Triggers 每 2 小時掃描一次（見 wrangler.toml）
 * fetch：GET / 看板網頁；GET /api/deals、GET /api/last-run 回 JSON；GET /healthz 健康檢查
 *
 * AI 提取層（v2 新增）：掃描發現來源頁面變更（content-changed / first-seen）時，
 * 把頁面內容丟給 OpenAI 相容的 LLM 提取優惠草稿，一律標 status=pending（待核實），
 * 由人工確認後改成 verified。設定：env.LLM_API_KEY（Bearer token）；
 * endpoint 與模型寫在下方 LLM 常數。每輪最多處理 LLM.maxSourcesPerRun 個來源，
 * 沒輪到的排入 llm-backlog（KV），下一輪優先處理。
 *
 * 資料放在 KV namespace DEAL_DATA，鍵值：sources / state / deals / archive / last-run / llm-backlog
 * 部署時由 GitHub Actions 或 worker/deploy.sh 從 repo 的 data/ 種子化。
 *
 * 如實說明：
 * - KV 這份資料與 repo（GitHub Actions 版）是各自獨立的副本，不會自動互相同步。
 * - LLM 提取可能誤讀頁面：產出只是草稿（pending），未經人工核實不會變成「已核實」。
 */

const KEY = {sources: 'sources', state: 'state', deals: 'deals', archive: 'archive', lastrun: 'last-run', backlog: 'llm-backlog'};
const UA = 'Mozilla/5.0 (compatible; DealRadarWorker/1.0; +https://github.com/finrod-chen/global-banefits)';
const CATEGORY_LABEL = {ai: 'AI 工具', crypto: 'Crypto', banking: '海外銀行/卡', 'vps-cloud': 'VPS/雲服務', software: '軟體/數位服務', other: '其他'};
const CATEGORIES = ['ai', 'crypto', 'banking', 'vps-cloud', 'software', 'other'];
const LLM = {baseUrl: 'https://apihub.agnes-ai.com/v1', model: 'agnes-3.0-flash', maxSourcesPerRun: 5, maxBodyChars: 12000, maxTokens: 1600};

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

// ---------- LLM 提取層 ----------

function dealKey(name, url) {
  return String(name || '').toLowerCase().trim() + '|' + String(url || '').replace(/\/+$/, '');
}

function normRegions(r) {
  if (Array.isArray(r)) return r.map(x => String(x));
  if (typeof r === 'string' && r.trim()) return [r.trim()];
  return null;
}

function normDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.trim()) ? d.trim() : null;
}

async function llmExtractDeals(env, source, bodyText) {
  const key = env.LLM_API_KEY;
  if (!key) return {deals: [], error: 'no LLM_API_KEY'};
  const system = '你是優惠情報提取器。從官方頁面文字中找出具體的優惠、活動、免費資源、折扣或獎勵計畫。只提取頁面上明確寫著的內容，不要推測、不要編造數字；頁面看不到的資訊填 null。若頁面沒有明確優惠，回傳 []。所有文字用繁體中文。';
  const user = '頁面名稱：' + source.name + '（類別 ' + source.category + '）\n頁面網址：' + source.url + '\n--- 頁面內容開始 ---\n' + bodyText + '\n--- 頁面內容結束 ---\n請只輸出一個 JSON 陣列，不要其他文字。每個元素欄位：name（活動名稱）、summary（優惠內容，含具體數字與條件）、requirements（參與條件與隱藏條件，如綁卡、消費門檻、邀請）、regions（適用地區，字串或字串陣列）、startDate（YYYY-MM-DD 或 null）、endDate（YYYY-MM-DD 或 null）、ongoing（boolean，長期活動為 true）、officialUrl（官方活動連結，頁面內容沒有就填頁面網址）、risks（風險提示：扣款、自動續約、資格失效等）。';
  try {
    const res = await fetch(LLM.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key},
      body: JSON.stringify({
        model: LLM.model,
        messages: [{role: "system", content: system}, {role: "user", content: user}],
        temperature: 0.2,
        max_tokens: LLM.maxTokens
      })
    });
    if (!res.ok) return {deals: [], error: "LLM HTTP " + res.status};
    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message ? String(data.choices[0].message.content || "") : "";
    const start = content.indexOf('[');
    const end = content.lastIndexOf(']');
    if (start < 0 || end <= start) return {deals: []};
    let arr;
    try { arr = JSON.parse(content.slice(start, end + 1)); } catch (e) { return {deals: [], error: "LLM 輸出解析失敗"}; }
    if (!Array.isArray(arr)) return {deals: []};
    const nowISO = new Date().toISOString();
    const today = nowISO.slice(0, 10);
    const out = [];
    let i = 0;
    for (const d of arr) {
      i++;
      if (!d || !d.name || !d.summary) continue;
      const url = typeof d.officialUrl === "string" && d.officialUrl.indexOf("http") === 0 ? d.officialUrl : source.url;
      const endDate = normDate(d.endDate);
      out.push({
        id: source.id + "-" + today.replace(/-/g, "") + "-" + i,
        name: String(d.name).slice(0, 120),
        category: CATEGORIES.indexOf(d.category) >= 0 ? d.category : source.category,
        summary: String(d.summary).slice(0, 500),
        value: {type: 'free', amountUSD: null, valueTWD: null, note: '待評估（LLM 草稿，未核實不填數字）'},
        requirements: d.requirements ? String(d.requirements).slice(0, 500) : "待補",
        regions: normRegions(d.regions) || ["待確認"],
        startDate: normDate(d.startDate),
        endDate: endDate,
        ongoing: d.ongoing === true ? true : !endDate,
        steps: Array.isArray(d.steps) ? d.steps.map(s => String(s)).slice(0, 8) : [],
        officialUrl: url,
        source: "LLM 自動提取（" + LLM.model + "）自「" + source.name + "」，待人工核實，提取時間 " + nowISO,
        lastVerified: today,
        risks: d.risks ? String(d.risks).slice(0, 500) : "LLM 草稿：未經人工核實，請以官方頁面為準",
        status: 'pending'
      });
    }
    return {deals: out};
  } catch (error) {
    return {deals: [], error: String(error && error.message ? error.message : error)};
  }
}

// ---------- 掃描主流程 ----------

export async function runScan(env) {
  const nowISO = new Date().toISOString();
  const today = nowISO.slice(0, 10);
  const sources = await getJson(env, KEY.sources, []);
  const state = await getJson(env, KEY.state, {sources: {}, lastRun: null});
  const deals = await getJson(env, KEY.deals, []);
  const archive = await getJson(env, KEY.archive, []);

  // 1. 擷取與變更偵測（變更/首次見到的頁面保留內容供 LLM 用）
  const results = [];
  const bodies = {};
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
        if ((source.watchKeywords || []).length > 0 && entry.keywordHits.length === 0) {
          entry.change = 'content-changed-suspect-expired';
        }
      } else {
        entry.change = 'unchanged';
      }
      if (entry.change === "first-seen" || entry.change === "content-changed") {
        bodies[source.id] = body.slice(0, LLM.maxBodyChars);
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
    const key = dealKey(deal.name, deal.officialUrl);
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

  // 3. LLM 提取（變更/首次見到的來源；每輪上限 LLM.maxSourcesPerRun，沒輪到的進 backlog）
  const backlog = await getJson(env, KEY.backlog, []);
  const sourceById = {};
  for (const s of sources) sourceById[s.id] = s;
  let candidates = results
    .filter(r => (r.change === 'first-seen' || r.change === 'content-changed') && bodies[r.id])
    .map(r => r.id);
  const queue = [];
  const queuedSeen = new Set();
  for (const id of backlog.concat(candidates)) {
    if (!queuedSeen.has(id) && sourceById[id]) { queuedSeen.add(id); queue.push(id); }
  }
  const todo = queue.slice(0, LLM.maxSourcesPerRun);
  const deferred = queue.slice(LLM.maxSourcesPerRun);
  const ai = {attempted: todo.length, extracted: 0, duplicateSkipped: 0, deferred: deferred.length, errors: [], noKey: !env.LLM_API_KEY};
  for (const id of todo) {
    const source = sourceById[id];
    const r = await llmExtractDeals(env, source, bodies[id] || "");
    for (const d of r.deals) {
      const k = dealKey(d.name, d.officialUrl);
      if (seen.has(k)) { ai.duplicateSkipped++; continue; }
      seen.set(k, d.id);
      keep.push(d);
      ai.extracted++;
    }
    if (r.error) ai.errors.push(id + ": " + r.error);
  }
  await putJson(env, KEY.backlog, deferred);

  // 4. 寫回
  const lastRun = {
    at: nowISO,
    summary: {
      sourcesChecked: results.length,
      changed: results.filter(r => String(r.change).indexOf('content-changed') === 0).length,
      fetchFailed: results.filter(r => r.change === 'fetch-failed').length,
      activeDeals: keep.length,
      archived: archive.length
    },
    aiExtraction: ai,
    needsReview: results.filter(r => r.change !== 'unchanged'),
    results
  };
  await putJson(env, KEY.state, state);
  await putJson(env, KEY.deals, keep);
  await putJson(env, KEY.archive, archive);
  await putJson(env, KEY.lastrun, lastRun);
  return lastRun;
}

// ---------- 看板渲染 ----------

function esc(s) {
  return String(s === undefined || s === null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
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
  const badge = d.status === "verified" ? "已核實" : "待核實";
  return "<tr><td><a href=\"" + esc(d.officialUrl) + "\">" + esc(d.name) + "</a></td><td>" + esc(CATEGORY_LABEL[d.category] || d.category) + "</td><td>" + esc(String(d.summary || "").slice(0, 90)) + "</td><td>" + esc(fmtValue(d)) + "</td><td>" + esc(fmtEnd(d)) + "</td><td>" + badge + "</td></tr>";
}
function sectionHtml(title, deals_, emptyText) {
  if (!deals_.length) return "<h2>" + esc(title) + "</h2><p class=\"empty\">" + esc(emptyText) + "</p>";
  return "<h2>" + esc(title) + "</h2><table><tr><th>活動名稱</th><th>類別</th><th>優惠內容</th><th>價值</th><th>截止</th><th>狀態</th></tr>" + deals_.map(rowHtml).join("") + "</table>";
}

function dashboardHtml(deals, lastRun) {
  const active = deals.filter(d => d.status !== 'example');
  const recent = active.filter(d => d.lastVerified && d.lastVerified >= daysAgoISO(2));
  const highValue = active.slice().sort((a, b) => (b.value && b.value.valueTWD ? b.value.valueTWD : -1) - (a.value && a.value.valueTWD ? a.value.valueTWD : -1));
  const today = new Date().toISOString().slice(0, 10);
  const endingSoon = active.filter(d => d.endDate && d.endDate >= today && d.endDate <= daysAheadISO(14) && d.ongoing !== true);
  const byCat = cat => active.filter(d => d.category === cat);
  const at = lastRun && lastRun.at ? lastRun.at : new Date().toISOString();
  const ai = lastRun && lastRun.aiExtraction ? lastRun.aiExtraction : null;
  const aiLine = ai ? "｜AI 提取：本輪處理 " + ai.attempted + " 個來源、產出 " + ai.extracted + " 條草稿（待核實）" + (ai.deferred ? "、待處理佇列 " + ai.deferred : "") : "｜AI 提取：尚未有掃描紀錄";
  return [
    "<!doctype html><html lang=\"zh-Hant\"><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "<title>GLOBAL DEAL RADAR｜全球好康情報中心</title>",
    "<style>body{font-family:system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#1f2328}h1{font-size:20px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #d0d7de;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f6f8fa}.empty{color:#656d76}.meta{color:#656d76;font-size:12px}a{color:#0969da}</style></head><body>",
    "<h1>GLOBAL DEAL RADAR｜全球好康情報中心</h1>",
    "<p class=\"meta\">本頁由 Cloudflare Worker 即時渲染，資料在 KV，每 2 小時自動掃描。最近掃描：" + esc(at) + "（UTC）" + esc(aiLine) + "。JSON：<a href=\"/api/deals\">/api/deals</a>、<a href=\"/api/last-run\">/api/last-run</a></p>",
    "<p class=\"meta\">原則：不編造優惠；無法核實的標「待核實」，沒有官方數字的地方留空。</p>",
    sectionHtml("A. 今日最新優惠（最近 48 小時）", recent, "本專區目前沒有符合條件的條目。"),
    sectionHtml("B. 高價值優惠排行榜", highValue, "本專區目前沒有符合條件的條目。"),
    sectionHtml("C. AI 工具免費與折扣專區", byCat("ai"), "本專區目前沒有符合條件的條目。"),
    sectionHtml("D. Crypto 空投與積分專區", byCat("crypto"), "本專區目前沒有符合條件的條目。"),
    sectionHtml("E. 海外銀行與銀行卡優惠", byCat("banking"), "本專區目前沒有符合條件的條目。"),
    sectionHtml("F. VPS 及雲服務專區", byCat("vps-cloud"), "本專區目前沒有符合條件的條目。"),
    sectionHtml("I. 軟體與數位服務專區", byCat("software"), "本專區目前沒有符合條件的條目。"),
    sectionHtml("G. 即將截止的活動（14 天內）", endingSoon, "本專區目前沒有符合條件的條目。"),
    "<p class=\"meta\">H. 已結束活動檔案請看 repo 的 dashboards/08-archive.md（Worker 版不重複存檔案）。</p>",
    "</body></html>"
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
