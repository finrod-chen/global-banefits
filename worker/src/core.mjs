/**
 * GLOBAL DEAL RADAR 掃描核心（Worker 與 GitHub Actions 共用）
 *
 * 只處理資料，不碰儲存：呼叫端把 sources / state / deals / archive 讀進來交給 scanCore，
 * 再把回傳的結果寫回 KV（worker/src/index.js）或 data/*.json（scripts/scan.mjs）。
 * 只用 fetch 與 Web Crypto，Workers 與 Node 20 以上都能跑。
 *
 * 如實說明：LLM 提取可能誤讀頁面，產出一律是 status=pending 的草稿、不填價值數字，
 * 要人工核實（看板管理模式或直接改資料）後才會變成「已核實」。
 */

export const CATEGORY_LABEL = {ai: 'AI 工具', crypto: 'Crypto', banking: '海外銀行/卡', 'vps-cloud': 'VPS/雲服務', software: '軟體/數位服務', other: '其他'};
export const CATEGORIES = Object.keys(CATEGORY_LABEL);
// 實測（2026-11-10，agnes 免費方案）：短時間連打會回 429「API rate limit for free users」，沒有 Retry-After，
// 約 30 秒後恢復；門檻不固定（連續 5 到 10 次之間觸發過）。單次送滿 12,000 字的請求本身不會被擋。
// 所以呼叫之間隔 16 秒（每分鐘不到 4 次），被限流時等 35 秒重試一次。等待不耗 CPU 時間。
export const LLM = {baseUrl: 'https://apihub.agnes-ai.com/v1', model: 'agnes-3.0-flash', maxSourcesPerRun: 5, maxHtmlChars: 400000, maxBodyChars: 12000, maxTokens: 1600, gapMs: 16000, retryWaitMs: 35000};

const UA = 'Mozilla/5.0 (compatible; DealRadarBot/1.0; +https://github.com/finrod-chen/global-banefits)';
const DAY = 86400000;
const NOTIFY_ENDING_DAYS = 3;

export function dealKey(name, url) {
  return String(name || '').toLowerCase().trim() + '|' + String(url || '').replace(/\/+$/, '');
}

async function sha256Hex16(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 把 HTML 壓成可讀文字再交給 LLM：原始 HTML 前段幾乎都是 <head> 與 script，直接截斷會看不到內容
export function htmlToText(html) {
  return String(html || '').slice(0, LLM.maxHtmlChars)
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/[ \t\r\f]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function normRegions(r) {
  if (Array.isArray(r)) return r.map(x => String(x));
  if (typeof r === 'string' && r.trim()) return [r.trim()];
  return null;
}
function normDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.trim()) ? d.trim() : null;
}

export async function llmExtractDeals(apiKey, source, bodyText) {
  if (!apiKey) return {deals: [], error: 'no LLM_API_KEY'};
  if (!bodyText) return {deals: [], error: '頁面沒有可讀文字'};
  const system = '你是優惠情報提取器。從官方頁面文字中找出具體的優惠：免費方案或免費額度、免費試用、限時折扣或促銷、新戶獎勵、回饋、空投或積分活動、學生或教育優惠。一般的付費方案與定價不是優惠，不要列出；年繳比月繳便宜這種常態價差也不算。只提取頁面上明確寫著的內容，不要推測、不要編造數字；頁面看不到的資訊填 null。若頁面沒有明確優惠，回傳 []。所有文字用繁體中文。';
  const user = '頁面名稱：' + source.name + '（類別 ' + source.category + '）\n頁面網址：' + source.url + '\n--- 頁面內容開始 ---\n' + bodyText + '\n--- 頁面內容結束 ---\n請只輸出一個 JSON 陣列，不要其他文字。每個元素欄位：name（活動名稱）、summary（優惠內容，含具體數字與條件）、requirements（參與條件與隱藏條件，如綁卡、消費門檻、邀請）、regions（適用地區，字串或字串陣列）、startDate（YYYY-MM-DD 或 null）、endDate（YYYY-MM-DD 或 null）、ongoing（boolean，長期活動為 true）、steps（參與步驟，字串陣列）、officialUrl（官方活動連結，頁面內容沒有就填頁面網址）、risks（風險提示：扣款、自動續約、資格失效等）。';
  try {
    const res = await fetch(LLM.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey},
      body: JSON.stringify({model: LLM.model, messages: [{role: 'system', content: system}, {role: 'user', content: user}], temperature: 0.2, max_tokens: LLM.maxTokens}),
      signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
      const retryAfter = Number(res.headers.get('retry-after'));
      return {deals: [], error: 'LLM HTTP ' + res.status + (detail ? ' ' + detail : ''), rateLimited: res.status === 429, retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0};
    }
    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message ? String(data.choices[0].message.content || '') : '';
    const start = content.indexOf('[');
    const end = content.lastIndexOf(']');
    if (start < 0 || end <= start) return {deals: []};
    let arr;
    try { arr = JSON.parse(content.slice(start, end + 1)); } catch (e) { return {deals: [], error: 'LLM 輸出解析失敗'}; }
    if (!Array.isArray(arr)) return {deals: []};
    const nowISO = new Date().toISOString();
    const today = nowISO.slice(0, 10);
    const out = [];
    let i = 0;
    for (const d of arr) {
      i++;
      if (!d || !d.name || !d.summary) continue;
      const url = typeof d.officialUrl === 'string' && /^https?:\/\//i.test(d.officialUrl) ? d.officialUrl : source.url;
      const endDate = normDate(d.endDate);
      out.push({
        id: source.id + '-' + today.replace(/-/g, '') + '-' + i,
        sourceId: source.id,
        name: String(d.name).slice(0, 120),
        category: CATEGORIES.indexOf(d.category) >= 0 ? d.category : source.category,
        summary: String(d.summary).slice(0, 500),
        value: {type: 'free', amountUSD: null, valueTWD: null, note: '待評估（LLM 草稿，未核實不填數字）'},
        requirements: d.requirements ? String(d.requirements).slice(0, 500) : '待補',
        regions: normRegions(d.regions) || ['待確認'],
        startDate: normDate(d.startDate),
        endDate,
        ongoing: d.ongoing === true ? true : !endDate,
        steps: Array.isArray(d.steps) ? d.steps.map(s => String(s).slice(0, 200)).slice(0, 8) : [],
        officialUrl: url,
        source: 'LLM 自動提取（' + LLM.model + '）自「' + source.name + '」，待人工核實，提取時間 ' + nowISO,
        lastVerified: today,
        risks: d.risks ? String(d.risks).slice(0, 500) : 'LLM 草稿：未經人工核實，請以官方頁面為準',
        status: 'pending'
      });
    }
    return {deals: out};
  } catch (error) {
    return {deals: [], error: String(error && error.message ? error.message : error)};
  }
}

/**
 * 跑一輪掃描。
 * @param data {sources, state, deals, archive}
 * @param cfg  {llmApiKey}
 * @returns    {state, deals, archive, lastRun, events}　events 給通知用
 */
export async function scanCore(data, cfg) {
  const nowISO = new Date().toISOString();
  const today = nowISO.slice(0, 10);
  const sources = (data.sources || []).filter(s => s && s.enabled !== false);
  const state = Object.assign({sources: {}, lastRun: null}, data.state || {});
  state.sources = state.sources || {};
  const deals = data.deals || [];
  const archive = (data.archive || []).slice();
  const llmApiKey = cfg && cfg.llmApiKey ? cfg.llmApiKey : '';
  const events = {newDrafts: [], suspectExpired: [], newFailures: [], expired: [], endingSoon: []};

  // 1. 擷取與變更偵測
  const results = [];
  const bodies = {};
  for (const source of sources) {
    const entry = {id: source.id, category: source.category, name: source.name, url: source.url, at: nowISO};
    const previous = state.sources[source.id] || null;
    try {
      const res = await fetch(source.url, {headers: {'User-Agent': UA, 'Accept-Language': 'en'}, redirect: 'follow', signal: AbortSignal.timeout(20000)});
      const body = await res.text();
      entry.httpStatus = res.status;
      entry.bytes = body.length;
      if (res.status >= 400) throw new Error('HTTP ' + res.status);
      entry.hash = await sha256Hex16(body);
      const lower = body.toLowerCase();
      entry.keywordHits = (source.watchKeywords || []).filter(k => lower.includes(String(k).toLowerCase()));
      if (!previous || !previous.hash) {
        entry.change = 'first-seen';
      } else if (previous.hash !== entry.hash) {
        entry.change = (source.watchKeywords || []).length > 0 && entry.keywordHits.length === 0 ? 'content-changed-suspect-expired' : 'content-changed';
      } else {
        entry.change = 'unchanged';
      }
      bodies[source.id] = body;
      if (entry.change === 'content-changed-suspect-expired') events.suspectExpired.push(entry);
    } catch (error) {
      entry.httpStatus = entry.httpStatus || 'error';
      entry.error = String(error && error.message ? error.message : error);
      entry.change = 'fetch-failed';
      // 只在「上一輪還好好的」時通知，長期擋爬蟲的站不會每輪吵一次
      if (previous && !previous.failed) events.newFailures.push(entry);
    }
    results.push(entry);
    // 擷取失敗時保留上一輪的雜湊，恢復後才能正確比對有沒有變更
    state.sources[source.id] = {hash: entry.hash || (previous ? previous.hash : null) || null, httpStatus: entry.httpStatus, failed: entry.change === 'fetch-failed', at: nowISO};
    // llmHash：上次成功交給 LLM 的頁面雜湊。跟現在的不一樣就代表這個版本還沒提取過
    if (previous && previous.llmHash) state.sources[source.id].llmHash = previous.llmHash;
  }

  // 2. 過期歸檔 + 重複優惠去重
  const seen = new Map();
  let keep = [];
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
      events.expired.push(deal);
      continue;
    }
    keep.push(deal);
  }
  // 人工退回過的條目不再讓 LLM 重新塞回來
  const rejected = new Set(archive.filter(d => d.status === 'rejected').map(d => dealKey(d.name, d.officialUrl)));

  // 3. LLM 提取：頁面目前版本還沒成功提取過的來源，每輪上限 maxSourcesPerRun，
  //    沒輪到或提取失敗（例如被限流）的留在 state.llmBacklog，下一輪再試
  const sourceById = {};
  for (const s of sources) sourceById[s.id] = s;
  const candidates = results.filter(r => r.hash && r.change !== 'content-changed-suspect-expired' && state.sources[r.id].llmHash !== r.hash).map(r => r.id);
  const queue = [];
  for (const id of (state.llmBacklog || []).concat(candidates)) {
    if (sourceById[id] && queue.indexOf(id) < 0) queue.push(id);
  }
  const ai = {attempted: 0, extracted: 0, duplicateSkipped: 0, deferred: 0, errors: [], noKey: !llmApiKey};
  let deferred = queue;
  if (llmApiKey) {
    // 這一輪抓不到頁面的來源留在佇列，下一輪再試
    const ready = queue.filter(id => bodies[id]);
    const todo = ready.slice(0, LLM.maxSourcesPerRun);
    const done = [];
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let n = 0; n < todo.length; n++) {
      const id = todo[n];
      if (n > 0) await sleep(LLM.gapMs);
      const text = htmlToText(bodies[id]).slice(0, LLM.maxBodyChars);
      let r = await llmExtractDeals(llmApiKey, sourceById[id], text);
      if (r.rateLimited) {
        await sleep(Math.max(r.retryAfterMs, LLM.retryWaitMs));
        r = await llmExtractDeals(llmApiKey, sourceById[id], text);
      }
      ai.attempted++;
      if (r.error) {
        ai.errors.push(id + ': ' + r.error);
        // 重試後還是被限流：這一輪不再打了，剩下的留給下一輪
        if (r.rateLimited) break;
        continue;
      }
      done.push(id);
      state.sources[id].llmHash = state.sources[id].hash;
      // 同一來源的舊草稿以最新頁面為準：先撤掉還沒核實的，再放新的（已核實的不動）
      keep = keep.filter(d => {
        if (d.status === 'pending' && d.sourceId === id) { seen.delete(dealKey(d.name, d.officialUrl)); return false; }
        return true;
      });
      const ids = new Set(keep.map(d => d.id));
      for (const d of r.deals) {
        const k = dealKey(d.name, d.officialUrl);
        if (seen.has(k) || rejected.has(k)) { ai.duplicateSkipped++; continue; }
        while (ids.has(d.id)) d.id += 'x';
        ids.add(d.id);
        seen.set(k, d.id);
        keep.push(d);
        events.newDrafts.push(d);
        ai.extracted++;
      }
    }
    deferred = queue.filter(id => done.indexOf(id) < 0);
  }
  ai.deferred = deferred.length;
  state.llmBacklog = deferred;

  // 4. 即將截止提醒（每條只提醒一次）
  const notified = new Set(state.notifiedEnding || []);
  const limit = new Date(Date.parse(today) + NOTIFY_ENDING_DAYS * DAY).toISOString().slice(0, 10);
  for (const d of keep) {
    if (d.status === 'example' || d.ongoing === true || !d.endDate) continue;
    if (d.endDate >= today && d.endDate <= limit && !notified.has(d.id)) { events.endingSoon.push(d); notified.add(d.id); }
  }
  const activeIds = new Set(keep.map(d => d.id));
  state.notifiedEnding = [...notified].filter(id => activeIds.has(id));
  state.lastRun = nowISO;

  const lastRun = {
    at: nowISO,
    summary: {
      sourcesChecked: results.length,
      changed: results.filter(r => String(r.change).indexOf('content-changed') === 0).length,
      fetchFailed: results.filter(r => r.change === 'fetch-failed').length,
      activeDeals: keep.filter(d => d.status !== 'example').length,
      pending: keep.filter(d => d.status === 'pending').length,
      archived: archive.length
    },
    aiExtraction: ai,
    needsReview: results.filter(r => r.change !== 'unchanged'),
    results
  };
  return {state, deals: keep, archive, lastRun, events};
}

/**
 * 人工審核一條優惠。action：verify（核實通過，可順便填估算價值）或 reject（退回並歸檔）。
 * 直接改傳入的陣列；找不到條目回傳 null。
 */
export function reviewDeal(deals, archive, id, action, patch) {
  const index = deals.findIndex(d => d.id === id);
  if (index < 0) return null;
  const deal = deals[index];
  const nowISO = new Date().toISOString();
  if (action === 'reject') {
    deals.splice(index, 1);
    const gone = Object.assign({}, deal, {status: 'rejected', archivedAt: nowISO, archiveReason: '人工退回'});
    archive.push(gone);
    return gone;
  }
  deal.status = 'verified';
  deal.lastVerified = nowISO.slice(0, 10);
  if (String(deal.source || '').indexOf('人工核實於') < 0) deal.source = String(deal.source || '').replace('，待人工核實', '') + '；人工核實於 ' + deal.lastVerified;
  const twd = patch ? Number(patch.valueTWD) : NaN;
  if (Number.isFinite(twd) && twd > 0) {
    deal.value = Object.assign({}, deal.value, {valueTWD: Math.round(twd), note: '人工核實時填入的估算價值'});
  }
  return deal;
}
