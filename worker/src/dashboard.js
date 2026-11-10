/**
 * GLOBAL DEAL RADAR 看板網頁（Worker 的 GET /）
 * 純伺服器端渲染 + 一小段前端篩選腳本；沒有外部資源，關掉 JS 也能看到全部條目。
 * 版面：統計列 → 篩選列（專區分頁、搜尋、排序）→ 票券式優惠卡 → 掃描報告與歸檔。
 * 狀態有三種：已核實（人工放行）、AI 預審通過（程式比對過原文，但沒人看過）、待核實。
 * 管理模式：頁尾輸入 ADMIN_TOKEN（只存在這台瀏覽器的 localStorage）後，待核實的卡片會出現
 * 「核實通過／退回」，頁首出現「立即掃描」；實際權限檢查在 index.js 的 POST 端點，
 * 這些操作是去觸發 GitHub Actions，所以按下後要等約 1 分鐘資料才會更新。
 */

import {CATEGORY_LABEL, REVIEW_FIELD_LABEL} from './core.mjs';

const DAY = 86400000;
const CHANGE_LABEL = {
  'first-seen': '首次見到',
  'content-changed': '內容變更',
  'content-changed-suspect-expired': '疑似失效',
  'fetch-failed': '擷取失敗',
  unchanged: '無變更'
};

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// 只放行 http(s) 連結：條目可能來自 LLM 草稿，不能讓 javascript: 之類的網址進到 href
function safeUrl(u) {
  return /^https?:\/\//i.test(String(u || '')) ? String(u) : '';
}
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}
function fmtTaipei(iso) {
  try {
    return new Intl.DateTimeFormat('zh-TW', {timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false}).format(new Date(iso));
  } catch (e) { return String(iso || ''); }
}
function valueOf(d) {
  const v = d.value || {};
  if (v.valueTWD) return {big: 'TWD ' + Number(v.valueTWD).toLocaleString('en-US'), cap: '估算價值', sort: Number(v.valueTWD)};
  const e = d.valueEstimate;
  if (e && Number(e.twd) > 0) {
    return {big: '≈ TWD ' + Number(e.twd).toLocaleString('en-US'), cap: e.basis === 'explicit-amount' ? 'AI 估（依原文金額）' : 'AI 估（推測）', sort: Number(e.twd), est: Number(e.twd)};
  }
  if (v.amountUSD) return {big: 'USD ' + Number(v.amountUSD).toLocaleString('en-US'), cap: '官方面額', sort: Number(v.amountUSD) * 32};
  if (String(v.note || '').indexOf('待評估') === 0 || !v.type) return {big: '待評估', cap: '尚無官方數字', sort: -1, dim: true};
  if (v.type === 'free') return {big: '免費', cap: '價值視使用而定', sort: 0};
  return {big: '待評估', cap: '尚無官方數字', sort: -1, dim: true};
}
const FLAG_LABEL = {
  'regular-pricing': '疑似常態定價，不是促銷',
  'kind-unclear': 'AI 無法判斷是否為促銷',
  'domain-mismatch': '連結網域與來源頁不同',
  'expired': '截止日已過',
  'quote-missing': '部分論點在頁面上找不到原文依據'
};
function flagTexts(rv) {
  const out = [];
  for (const f of (rv && rv.flags) || []) {
    if (f === 'numbers-missing') out.push('摘要裡的數字 ' + ((rv.numbersMissing || []).join('、') || '—') + ' 在頁面上找不到');
    else if (FLAG_LABEL[f]) out.push(FLAG_LABEL[f]);
  }
  return out;
}
function reviewLine(rv) {
  if (!rv || !rv.coverage) return '<p class="ailine">AI 預審：尚未進行</p>';
  const problems = flagTexts(rv);
  return '<p class="ailine' + (rv.passed ? ' ok' : ' warn') + '">AI 預審：原文對照 ' + esc(rv.coverage.found) + '/' + esc(rv.coverage.total) +
    (problems.length ? '　' + problems.map(esc).join('；') : '，數字、網域與截止日都符合') + '</p>';
}
function reviewDetail(rv, e) {
  let html = '';
  if (rv && Array.isArray(rv.claims) && rv.claims.length) {
    html += '<dt>AI 預審的原文依據</dt><dd><ul class="claims">' + rv.claims.map(c =>
      '<li class="' + (c.found ? 'yes' : 'no') + '"><b>' + (c.found ? '✓' : '✗') + ' ' + esc(REVIEW_FIELD_LABEL[c.field] || c.field) + '</b>' +
      (c.found ? '：「' + esc(c.quote) + '」' : '：頁面上找不到對應原文') + '</li>').join('') + '</ul>' +
      (rv.kindReason ? '<span class="muted">AI 判斷：' + esc(rv.kindReason) + '</span>' : '') + '</dd>';
  }
  if (e && Number(e.twd) > 0) {
    html += '<dt>AI 估值依據（信心 ' + esc(e.confidence || 'low') + '）</dt><dd>' + esc(e.note || '') + (e.quote ? '<br><span class="muted">原文：「' + esc(e.quote) + '」</span>' : '') + '</dd>';
  }
  return html;
}

function deadlineOf(d, todayISO) {
  if (d.ongoing === true) return {text: '長期活動', days: null};
  if (!d.endDate) return {text: '截止日未知', days: null};
  const days = Math.round((Date.parse(d.endDate) - Date.parse(todayISO)) / DAY);
  const md = d.endDate.slice(5).replace('-', '/');
  if (days < 0) return {text: md + ' 已截止', days};
  if (days === 0) return {text: '今天截止', days};
  return {text: '剩 ' + days + ' 天 · ' + md, days};
}

function cardHtml(d, todayISO, recentISO) {
  const url = safeUrl(d.officialUrl);
  const v = valueOf(d);
  const dl = deadlineOf(d, todayISO);
  const status = d.status === 'verified' ? 'verified' : (d.status === 'ai-reviewed' ? 'ai-reviewed' : 'pending');
  const verified = status === 'verified';
  const rv = d.review && typeof d.review === 'object' ? d.review : null;
  const soon = dl.days !== null && dl.days >= 0 && dl.days <= 14;
  const recent = !!(d.lastVerified && d.lastVerified >= recentISO);
  const regions = Array.isArray(d.regions) ? d.regions.join('、') : String(d.regions || '');
  const steps = Array.isArray(d.steps) ? d.steps : [];
  const text = [d.name, d.summary, d.requirements, regions, CATEGORY_LABEL[d.category] || d.category].join(' ').toLowerCase();
  const title = url
    ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(d.name) + '</a>'
    : esc(d.name);
  const detail = [
    d.requirements ? '<dt>參與條件</dt><dd>' + esc(d.requirements) + '</dd>' : '',
    steps.length ? '<dt>參與步驟</dt><dd><ol>' + steps.map(s => '<li>' + esc(s) + '</li>').join('') + '</ol></dd>' : '',
    d.risks ? '<dt>風險提示</dt><dd>' + esc(d.risks) + '</dd>' : '',
    d.source ? '<dt>資訊來源</dt><dd>' + esc(d.source) + '</dd>' : '',
    reviewDetail(rv, d.valueEstimate)
  ].join('');
  const badge = verified ? '<span class="badge ok">已核實</span>' : (status === 'ai-reviewed' ? '<span class="badge ai">AI 預審通過</span>' : '<span class="badge wait">待核實</span>');
  const warnBadge = !verified && rv && (rv.flags || []).indexOf('regular-pricing') >= 0 ? '<span class="badge hot">疑似常態定價</span>' : '';
  return '<article class="ticket' + (verified ? '' : (status === 'ai-reviewed' ? ' is-ai' : ' is-pending')) + '" data-id="' + esc(d.id) + '" data-status="' + status + '" data-est="' + (v.est || '') + '" data-cat="' + esc(d.category) + '" data-verified="' + (verified ? 1 : 0) +
    '" data-recent="' + (recent ? 1 : 0) + '" data-soon="' + (soon ? 1 : 0) + '" data-value="' + v.sort + '" data-days="' + (dl.days === null ? 99999 : dl.days) +
    '" data-checked="' + esc(d.lastVerified || '') + '" data-text="' + esc(text) + '">' +
    '<div class="body">' +
      '<p class="tags"><span class="cat">' + esc(CATEGORY_LABEL[d.category] || d.category) + '</span>' +
        badge + warnBadge +
        (soon ? '<span class="badge hot">即將截止</span>' : '') + '</p>' +
      '<h3>' + title + '</h3>' +
      '<p class="summary">' + esc(d.summary) + '</p>' +
      '<p class="meta">' + [regions ? esc(regions) : '', d.lastVerified ? (verified ? '核實於 ' : '提取於 ') + esc(d.lastVerified) : '', url ? esc(hostOf(url)) : ''].filter(Boolean).join('<i></i>') + '</p>' +
      (verified ? '' : reviewLine(rv)) +
      (detail ? '<details><summary>條件、步驟與風險</summary><dl>' + detail + '</dl></details>' : '') +
      (verified ? '' : '<p class="review admin-only"><button type="button" data-act="verify">核實通過</button><button type="button" data-act="reject">退回</button></p>') +
    '</div>' +
    '<div class="stub">' +
      '<p class="cap">' + esc(v.cap) + '</p>' +
      '<p class="value' + (v.dim ? ' dim' : '') + (v.est ? ' est' : '') + '">' + esc(v.big) + '</p>' +
      '<p class="deadline' + (soon ? ' hot' : '') + '">' + esc(dl.text) + '</p>' +
      (url ? '<a class="go" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">前往官方頁面 <span aria-hidden="true">→</span></a>' : '') +
    '</div>' +
  '</article>';
}

function scanHtml(lastRun, archive) {
  if (!lastRun) return '<section class="panel"><h2>掃描報告</h2><p class="muted">尚未有掃描紀錄，下一輪排程（每 2 小時）跑完後會出現在這裡。</p></section>';
  const s = lastRun.summary || {};
  const ai = lastRun.aiExtraction || null;
  const rows = (lastRun.results || []).map(r => {
    const u = safeUrl(r.url);
    const cls = r.change === 'unchanged' ? '' : (r.change === 'fetch-failed' || r.change === 'content-changed-suspect-expired' ? ' class="bad"' : ' class="chg"');
    return '<tr><td>' + (u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(r.name) + '</a>' : esc(r.name)) + '</td><td>' +
      esc(CATEGORY_LABEL[r.category] || r.category) + '</td><td' + cls + '>' + esc(CHANGE_LABEL[r.change] || r.change) + '</td><td class="num">' + esc(r.httpStatus) + '</td></tr>';
  }).join('');
  const aiLine = ai
    ? (ai.noKey ? 'AI 提取未啟用（未設定 LLM_API_KEY）' : 'AI 提取：處理 ' + ai.attempted + ' 個來源，產出 ' + ai.extracted + ' 條草稿' + (ai.deferred ? '，佇列 ' + ai.deferred : '') + (ai.errors && ai.errors.length ? '，錯誤 ' + ai.errors.length : ''))
    : '';
  const rvs = lastRun.aiReview;
  const aiReviewLine = rvs && !(ai && ai.noKey) ? '；AI 預審：處理 ' + rvs.attempted + ' 條，通過 ' + rvs.passed + ' 條，有疑慮 ' + rvs.flagged + ' 條' + (rvs.errors && rvs.errors.length ? '，錯誤 ' + rvs.errors.length : '') : '';
  const nt = lastRun.notification;
  const ntLine = nt ? (nt.sent ? '已發送通知。' : (nt.error ? '通知失敗：' + nt.error + '。' : (nt.reason || '') + '。')) : '';
  const arch = (archive || []).slice(-30).reverse().map(d => '<li>' + esc(d.name) + '<span class="muted">　' + esc(d.archiveReason || '') + ' · ' + esc(String(d.archivedAt || '').slice(0, 10)) + '</span></li>').join('');
  return '<section class="panel"><h2>掃描報告</h2>' +
    '<p class="muted">最近一輪 ' + esc(fmtTaipei(lastRun.at)) + '（台北時間）：檢查 ' + (s.sourcesChecked || 0) + ' 個來源，' + (s.changed || 0) + ' 個有變更，' + (s.fetchFailed || 0) + ' 個擷取失敗。' + esc(aiLine + aiReviewLine) + (aiLine ? '。' : '') + esc(ntLine) + '</p>' +
    (rows ? '<details><summary>各來源結果（' + (lastRun.results || []).length + '）</summary><div class="scroll"><table><thead><tr><th>來源</th><th>類別</th><th>結果</th><th class="num">HTTP</th></tr></thead><tbody>' + rows + '</tbody></table></div></details>' : '') +
    '<details><summary>已結束活動（' + (archive || []).length + '）</summary>' + (arch ? '<ul class="arch">' + arch + '</ul>' : '<p class="muted">歸檔目前為空。</p>') + '</details>' +
    '</section>';
}

const CSS = `
:root{--bg:#f4f1ea;--surface:#fffdf8;--ink:#1c1a17;--muted:#6b655c;--line:#ddd6c8;--accent:#b8400f;--accent-ink:#fff;--ok:#1f7a4d;--ok-bg:#e3f1e8;--wait:#8a5a00;--wait-bg:#f6ebcf;--hot:#b3261e;--hot-bg:#f9e2df;--chip:#ebe6da;--ai:#2b5fb8;--ai-bg:#e2ebf9;
--sans:"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#141311;--surface:#1d1b18;--ink:#ece7dc;--muted:#a39c8f;--line:#37332c;--accent:#f08a4b;--accent-ink:#1c1206;--ok:#6cc79a;--ok-bg:#1c3327;--wait:#e2b655;--wait-bg:#3a2f14;--hot:#f2877f;--hot-bg:#402120;--chip:#2a2722;--ai:#8db4f0;--ai-bg:#1b2a44}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 var(--sans);-webkit-text-size-adjust:100%}
a{color:inherit}
.wrap{max-width:1040px;margin:0 auto;padding:0 16px}
header.top{padding:36px 0 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.mark{width:44px;height:44px;flex:none;color:var(--accent)}
.brand{flex:1;min-width:220px}
.brand small{font:600 11px/1 var(--mono);letter-spacing:.18em;color:var(--accent)}
.brand h1{margin:6px 0 0;font-size:26px;line-height:1.2;letter-spacing:.02em;text-wrap:balance}
.pulse{font-size:13px;color:var(--muted);text-align:right}
.pulse b{display:block;color:var(--ink);font:600 15px/1.5 var(--mono);font-variant-numeric:tabular-nums}
.stats{display:grid;grid-template-columns:repeat(6,1fr);border:1px solid var(--line);border-radius:14px;background:var(--surface);overflow:hidden}
.stats div{padding:14px 16px;border-left:1px solid var(--line)}
.stats div:first-child{border-left:0}
.stats dt{font-size:12px;color:var(--muted)}
.stats dd{margin:2px 0 0;font:600 26px/1.2 var(--mono);font-variant-numeric:tabular-nums}
.stats .ai dd{color:var(--ai)}.stats .ok dd{color:var(--ok)}.stats .wait dd{color:var(--wait)}.stats .hot dd{color:var(--hot)}
.bar{position:sticky;top:0;z-index:5;background:var(--bg);padding:14px 0 12px;margin-top:14px;border-bottom:1px solid var(--line)}
.tabs{display:flex;gap:6px;overflow-x:auto;padding-bottom:2px;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs button{flex:none;font:inherit;font-size:14px;color:var(--ink);background:var(--chip);border:1px solid transparent;border-radius:999px;padding:6px 14px;cursor:pointer;white-space:nowrap}
.tabs button span{font:12px var(--mono);color:var(--muted);margin-left:6px}
.tabs button:hover{border-color:var(--line)}
.tabs button[aria-pressed=true]{background:var(--ink);color:var(--bg)}
.tabs button[aria-pressed=true] span{color:inherit;opacity:.7}
.tools{display:flex;gap:10px;margin-top:10px;flex-wrap:wrap;align-items:center}
.tools input[type=search],.tools select{font:inherit;font-size:14px;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:8px 12px;min-height:40px}
.tools input[type=search]{flex:1;min-width:180px}
.tools label{font-size:14px;color:var(--muted);display:flex;gap:6px;align-items:center;white-space:nowrap}
button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.list{display:grid;gap:14px;padding:18px 0 8px}
.ticket{display:grid;grid-template-columns:minmax(0,1fr) 220px;background:var(--surface);border:1px solid var(--line);border-radius:14px;position:relative}
.ticket[hidden]{display:none}
.ticket.is-pending{border-style:dashed}
.ticket.is-ai{border-style:dashed;border-color:var(--ai)}
.body{padding:18px 22px;min-width:0}
.stub{padding:18px 20px;border-left:2px dashed var(--line);display:flex;flex-direction:column;justify-content:center;gap:2px;position:relative}
.stub:before,.stub:after{content:"";position:absolute;left:-10px;width:18px;height:18px;border-radius:50%;background:var(--bg);border:1px solid var(--line)}
.stub:before{top:-10px;clip-path:inset(50% 0 0 0)}
.stub:after{bottom:-10px;clip-path:inset(0 0 50% 0)}
.tags{margin:0 0 6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.cat{font:600 11px/1 var(--mono);letter-spacing:.08em;color:var(--muted);margin-right:4px}
.badge{font-size:12px;line-height:1;padding:4px 8px;border-radius:6px}
.badge.ai{color:var(--ai);background:var(--ai-bg)}.badge.ok{color:var(--ok);background:var(--ok-bg)}.badge.wait{color:var(--wait);background:var(--wait-bg)}.badge.hot{color:var(--hot);background:var(--hot-bg)}
.ticket h3{margin:0;font-size:18px;line-height:1.4;text-wrap:pretty}
.ticket h3 a{text-decoration:none}
.ticket h3 a:hover{text-decoration:underline;text-decoration-color:var(--accent);text-underline-offset:4px}
.summary{margin:8px 0 0;max-width:62ch}
.meta{margin:10px 0 0;font-size:13px;color:var(--muted);overflow-wrap:anywhere}
.meta i{display:inline-block;width:3px;height:3px;border-radius:50%;background:currentColor;margin:0 8px;vertical-align:middle}
details{margin-top:12px}
summary{cursor:pointer;font-size:13px;color:var(--muted);width:fit-content}
summary:hover{color:var(--ink)}
dl{margin:10px 0 0;font-size:14px}
dl dt{font-size:12px;color:var(--muted);margin-top:10px}
dl dd{margin:2px 0 0;max-width:66ch}
dl ol{margin:0;padding-left:20px}
.ailine{margin:8px 0 0;font-size:13px;color:var(--muted)}.ailine.ok{color:var(--ai)}.ailine.warn{color:var(--wait)}
.claims{margin:0;padding:0;list-style:none;font-size:13px}.claims li{margin:4px 0;overflow-wrap:anywhere}.claims .yes b{color:var(--ok)}.claims .no b{color:var(--hot)}
.cap{margin:0;font-size:12px;color:var(--muted)}
.value{margin:0;font:700 24px/1.25 var(--mono);font-variant-numeric:tabular-nums;color:var(--accent);overflow-wrap:anywhere}
.value.est{color:var(--ai)}
.value.dim{color:var(--muted);font-family:var(--sans);font-weight:600;font-size:20px}
.deadline{margin:4px 0 0;font-size:13px;color:var(--muted)}
.deadline.hot{color:var(--hot);font-weight:600}
.go{margin-top:12px;display:inline-flex;justify-content:center;gap:6px;text-decoration:none;font-size:14px;font-weight:600;background:var(--accent);color:var(--accent-ink);border-radius:10px;padding:9px 12px}
.go:hover{filter:brightness(1.08)}
.empty{border:1px dashed var(--line);border-radius:14px;padding:36px 20px;text-align:center;color:var(--muted)}
.empty b{display:block;color:var(--ink);font-size:16px;margin-bottom:4px}
.panel{margin:26px 0 0;padding:20px 22px;background:var(--surface);border:1px solid var(--line);border-radius:14px}
.panel h2{margin:0 0 6px;font-size:16px}
.muted{color:var(--muted);font-size:13px;margin:0}
.scroll{overflow-x:auto;margin-top:10px}
table{border-collapse:collapse;width:100%;font-size:13px;min-width:460px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line)}
th{font-weight:600;color:var(--muted);font-size:12px}
.num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}
td.chg{color:var(--wait)}td.bad{color:var(--hot)}
.arch{margin:10px 0 0;padding-left:18px;font-size:14px}
footer{padding:22px 0 48px;font-size:13px;color:var(--muted)}
.admin-only{display:none}
body.admin .review.admin-only{display:flex}body.admin #scan{display:block}
.review{margin:14px 0 0;gap:8px}
.review button,#scan{font:inherit;font-size:13px;font-weight:600;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:7px 14px;min-height:36px;cursor:pointer}
.review button[data-act=verify]{color:var(--ok);border-color:currentColor}
.review button[data-act=reject]{color:var(--hot)}
.review button:disabled,#scan:disabled{opacity:.5;cursor:wait}
#scan{margin:8px 0 0 auto}
button.link{font:inherit;color:var(--ink);background:none;border:0;padding:0;text-decoration:underline;cursor:pointer}
#msg{margin-left:10px;color:var(--hot)}#msg.ok{color:var(--ok)}
footer a{color:var(--ink)}
@media (max-width:720px){
header.top{padding-top:24px}.brand h1{font-size:22px}.pulse{text-align:left;width:100%}
.stats{grid-template-columns:repeat(2,1fr)}.stats div{border-left:0;border-top:1px solid var(--line)}.stats div:nth-child(-n+2){border-top:0}.stats div:nth-child(even){border-left:1px solid var(--line)}.stats div:last-child:nth-child(odd){grid-column:1/-1}
.ticket{grid-template-columns:1fr}.body{padding:16px}
.stub{border-left:0;border-top:2px dashed var(--line);padding:14px 16px 16px;display:grid;grid-template-columns:1fr auto;align-items:end;column-gap:12px}
.stub:before,.stub:after{top:-10px;bottom:auto;clip-path:inset(0 0 0 50%)}.stub:after{left:auto;right:-10px;clip-path:inset(0 50% 0 0)}
.stub .cap,.stub .value,.stub .deadline{grid-column:1}.stub .go{grid-column:2;grid-row:1/4;margin:0}
}
@media (prefers-reduced-motion:no-preference){.mark .sweep{transform-origin:22px 22px;animation:sweep 6s linear infinite}@keyframes sweep{to{transform:rotate(360deg)}}}
`;

// 前端篩選：依 data-* 屬性顯示/隱藏與排序，狀態記在網址 hash
const SCRIPT = `
(function(){
var list=document.getElementById('list'),cards=[].slice.call(list.querySelectorAll('.ticket')),
tabs=[].slice.call(document.querySelectorAll('.tabs button')),q=document.getElementById('q'),
st=document.getElementById('st'),sort=document.getElementById('sort'),empty=document.getElementById('empty'),
count=document.getElementById('count'),tab='all';
function match(c){
if(tab==='recent'&&c.dataset.recent!=='1')return false;
if(tab==='soon'&&c.dataset.soon!=='1')return false;
if(tab!=='all'&&tab!=='recent'&&tab!=='soon'&&c.dataset.cat!==tab)return false;
if(st.value!=='all'&&c.dataset.status!==st.value)return false;
var t=q.value.trim().toLowerCase();
return !t||c.dataset.text.indexOf(t)>=0;}
function apply(){
var s=sort.value,shown=0;
cards.slice().sort(function(a,b){
if(s==='days')return a.dataset.days-b.dataset.days||b.dataset.value-a.dataset.value;
if(s==='checked')return a.dataset.checked<b.dataset.checked?1:a.dataset.checked>b.dataset.checked?-1:0;
return b.dataset.value-a.dataset.value||b.dataset.verified-a.dataset.verified;
}).forEach(function(c){var m=match(c);c.hidden=!m;if(m)shown++;list.appendChild(c);});
empty.hidden=shown>0;count.textContent='顯示 '+shown+' / '+cards.length+' 條';
tabs.forEach(function(b){b.setAttribute('aria-pressed',b.dataset.tab===tab?'true':'false');});}
tabs.forEach(function(b){b.addEventListener('click',function(){tab=b.dataset.tab;try{history.replaceState(null,'','#'+tab);}catch(e){}apply();});});
[q,st,sort].forEach(function(el){el.addEventListener('input',apply);});
var msg=document.getElementById('msg'),adminBtn=document.getElementById('admin'),token='';
try{token=localStorage.getItem('dealRadarAdminToken')||'';}catch(e){}
function setAdmin(t){token=t;try{t?localStorage.setItem('dealRadarAdminToken',t):localStorage.removeItem('dealRadarAdminToken');}catch(e){}
document.body.classList.toggle('admin',!!t);adminBtn.textContent=t?'離開管理模式':'管理模式';}
function call(path,body){msg.textContent='';msg.className='';
return fetch(path,{method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body||{})})
.then(function(r){return r.json().catch(function(){return {};}).then(function(j){if(!r.ok){if(r.status===401)setAdmin('');throw new Error(j.error||('HTTP '+r.status));}return j;});});}
adminBtn.addEventListener('click',function(){if(token){setAdmin('');return;}var t=prompt('輸入 ADMIN_TOKEN（只存在這台瀏覽器）');if(t)setAdmin(t.trim());});
// 送出後每 6 秒問一次最新資料，看到變化就重新整理；等太久就提示稍後自己重新整理
function waitFor(url,changed,tries,onDone,onGiveUp){var n=0;(function tick(){
fetch(url).then(function(r){return r.ok?r.json():null;}).then(function(j){if(j!==null&&changed(j)){onDone();return;}retry();}).catch(retry);
function retry(){if(++n>=tries){onGiveUp();return;}setTimeout(tick,6000);}})();}
var scanBtn=document.getElementById('scan');
scanBtn.addEventListener('click',function(){var b=scanBtn;b.disabled=true;b.textContent='掃描中…';
call('/api/scan').then(function(j){msg.className='ok';msg.textContent='已送出，掃描約需 3 到 5 分鐘，完成後這頁會自動更新。';
waitFor('/api/last-run?fresh=1',function(r){return r&&r.at&&r.at!==b.dataset.runAt;},60,function(){location.reload();},function(){msg.textContent='掃描還沒完成，請稍後重新整理。';b.textContent='已送出';});
}).catch(function(err){msg.textContent=err.message;b.disabled=false;b.textContent='立即掃描';});});
list.addEventListener('click',function(e){var b=e.target.closest('button[data-act]');if(!b)return;
var card=b.closest('.ticket'),act=b.dataset.act,body={};
if(act==='reject'&&!confirm('退回這條草稿並歸檔？'))return;
if(act==='verify'){var est=card.dataset.est||'';var v=prompt('已對照官方頁面確認內容無誤。價值（新台幣）'+(est?'：已帶入 AI 估值，可直接放行或修改':'，可留空'),est);if(v===null)return;if(v.trim())body.valueTWD=Number(v.replace(/[^0-9.]/g,''));}
b.disabled=true;
call('/api/deals/'+encodeURIComponent(card.dataset.id)+'/'+act,body).then(function(j){var id=card.dataset.id,r=card.querySelector('.review');msg.className='ok';msg.textContent=j.message||'已送出';if(r)r.textContent='處理中…完成後這頁會自動更新';
waitFor('/api/deals?fresh=1',function(list){var d=list.filter(function(x){return x.id===id;})[0];return act==='reject'?!d:(!d||d.status==='verified');},18,function(){location.reload();},function(){if(r)r.textContent='已送出，但還沒看到更新，請稍後重新整理';});
}).catch(function(err){msg.textContent=err.message;b.disabled=false;});});
setAdmin(token);
var h=location.hash.slice(1);if(h&&tabs.some(function(b){return b.dataset.tab===h;}))tab=h;
apply();
})();
`;

export function dashboardHtml(deals, lastRun, archive, meta) {
  const now = Date.now();
  const todayISO = new Date(now).toISOString().slice(0, 10);
  const recentISO = new Date(now - 2 * DAY).toISOString().slice(0, 10);
  const active = (deals || []).filter(d => d && d.status !== 'example')
    .sort((a, b) => valueOf(b).sort - valueOf(a).sort || (b.status === 'verified') - (a.status === 'verified'));
  const cards = active.map(d => cardHtml(d, todayISO, recentISO));
  const verified = active.filter(d => d.status === 'verified').length;
  const aiOk = active.filter(d => d.status === 'ai-reviewed').length;
  const isSoon = d => { const x = deadlineOf(d, todayISO).days; return x !== null && x >= 0 && x <= 14; };
  const soon = active.filter(isSoon).length;
  const recent = active.filter(d => d.lastVerified && d.lastVerified >= recentISO).length;
  const sources = lastRun && lastRun.summary ? lastRun.summary.sourcesChecked : null;
  const byCat = c => active.filter(d => d.category === c).length;
  const tab = (id, label, n) => '<button type="button" data-tab="' + id + '" aria-pressed="' + (id === 'all' ? 'true' : 'false') + '">' + label + '<span>' + n + '</span></button>';
  const tabs = [tab('all', '全部', active.length), tab('recent', '最新 48 小時', recent), tab('soon', '即將截止', soon)]
    .concat(Object.keys(CATEGORY_LABEL).filter(c => c !== 'other' || byCat(c)).map(c => tab(c, CATEGORY_LABEL[c], byCat(c)))).join('');
  const stat = (cls, label, n) => '<div class="' + cls + '"><dt>' + label + '</dt><dd>' + n + '</dd></div>';
  return '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light dark">' +
    '<title>全球好康情報中心｜GLOBAL DEAL RADAR</title>' +
    '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 44 44%27%3E%3Ccircle cx=%2722%27 cy=%2722%27 r=%2720%27 fill=%27%23b8400f%27/%3E%3Ccircle cx=%2722%27 cy=%2722%27 r=%2711%27 fill=%27none%27 stroke=%27%23fff%27 stroke-width=%273%27/%3E%3Ccircle cx=%2722%27 cy=%2722%27 r=%273%27 fill=%27%23fff%27/%3E%3C/svg%3E">' +
    '<style>' + CSS + '</style></head><body><div class="wrap">' +
    '<header class="top">' +
      '<svg class="mark" viewBox="0 0 44 44" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="22" cy="22" r="20" stroke-width="1.5"/><circle cx="22" cy="22" r="12" stroke-width="1.5" opacity=".55"/><circle cx="22" cy="22" r="3" fill="currentColor" stroke="none"/><path class="sweep" d="M22 22 L22 2 A20 20 0 0 1 39.3 12 Z" fill="currentColor" stroke="none" opacity=".28"/></svg>' +
      '<div class="brand"><small>GLOBAL DEAL RADAR</small><h1>全球好康情報中心</h1></div>' +
      '<p class="pulse">最近掃描（台北時間）<b>' + (lastRun && lastRun.at ? esc(fmtTaipei(lastRun.at)) : '尚未掃描') + '</b>每 2 小時自動更新<button type="button" id="scan" class="admin-only" data-run-at="' + esc(lastRun && lastRun.at ? lastRun.at : '') + '">立即掃描</button></p>' +
    '</header>' +
    '<dl class="stats">' + stat('', '有效優惠', active.length) + stat('ok', '已核實', verified) + stat('ai', 'AI 預審通過', aiOk) + stat('wait', '待核實', active.length - verified - aiOk) +
      stat('hot', '14 天內截止', soon) + stat('', '監控來源', sources === null || sources === undefined ? '—' : sources) + '</dl>' +
    '<div class="bar"><nav class="tabs" aria-label="專區">' + tabs + '</nav>' +
      '<div class="tools"><input id="q" type="search" placeholder="搜尋名稱、內容、地區" aria-label="搜尋優惠">' +
      '<select id="sort" aria-label="排序"><option value="value">價值高到低</option><option value="days">截止日近到遠</option><option value="checked">最近核實</option></select>' +
      '<select id="st" aria-label="狀態"><option value="all">所有狀態</option><option value="verified">已核實</option><option value="ai-reviewed">AI 預審通過</option><option value="pending">待核實</option></select>' +
      '<span class="muted" id="count" aria-live="polite"></span></div></div>' +
    '<main><div class="list" id="list">' + cards.join('') + '</div>' +
      '<div class="empty" id="empty"' + (cards.length ? ' hidden' : '') + '><b>這裡目前沒有條目</b>寧缺勿濫：只收官方頁面核對過的優惠，等掃描與核實流程填充。</div>' +
      scanHtml(lastRun, archive) + '</main>' +
    '<footer>原則：不編造優惠。只有「已核實」是人工放行的；「AI 預審通過」是程式比對過頁面原文，但沒有人看過；AI 估值是推測，請以官方頁面為準。　' +
      (meta && meta.repo ? '資料來自 <a href="https://github.com/' + esc(meta.repo) + '">' + esc(meta.repo) + '</a>（GitHub Actions 每 2 小時掃描並提交）。' : '') +
      (meta && meta.stale ? '<strong>暫時讀不到 GitHub，顯示的是上一份資料。</strong>' : '') + '　資料：<a href="/api/deals">/api/deals</a>　<a href="/api/archive">/api/archive</a>　<a href="/api/last-run">/api/last-run</a>　<button type="button" id="admin" class="link">管理模式</button><span id="msg" role="status"></span></footer>' +
    '</div><script>' + SCRIPT + '</script></body></html>';
}
