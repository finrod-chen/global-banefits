/**
 * 推播通知（Telegram）。Worker 與 GitHub Actions 共用。
 * 需要 TELEGRAM_BOT_TOKEN 與 TELEGRAM_CHAT_ID；沒設就不發，掃描其餘功能不受影響。
 * 只在有事的時候發：新草稿、疑似失效、來源剛開始擷取失敗、三天內截止、已過期歸檔。
 */
import {CATEGORY_LABEL} from './core.mjs';

const MAX_ITEMS = 8;

function section(title, items, line) {
  if (!items.length) return '';
  const rows = items.slice(0, MAX_ITEMS).map(line);
  if (items.length > MAX_ITEMS) rows.push('…另有 ' + (items.length - MAX_ITEMS) + ' 條');
  return title + '（' + items.length + '）\n' + rows.join('\n');
}

/** 把一輪掃描的事件組成通知文字；沒有值得通知的事回傳 null。 */
export function buildDigest(events, lastRun, dashboardUrl) {
  if (!events) return null;
  const parts = [
    section('🆕 新草稿，待核實', events.newDrafts, d => '・[' + (CATEGORY_LABEL[d.category] || d.category) + '] ' + d.name + '\n　' + d.officialUrl),
    section('⏰ 三天內截止', events.endingSoon, d => '・' + d.name + '（' + d.endDate + '）\n　' + d.officialUrl),
    section('⚠️ 疑似失效，關鍵字從頁面消失', events.suspectExpired, r => '・' + r.name + '\n　' + r.url),
    section('🚫 來源擷取失敗', events.newFailures, r => '・' + r.name + '：' + (r.error || r.httpStatus)),
    section('📦 已過期歸檔', events.expired, d => '・' + d.name)
  ].filter(Boolean);
  if (!parts.length) return null;
  const s = lastRun && lastRun.summary ? lastRun.summary : {};
  const head = '全球好康情報中心｜掃描 ' + (s.sourcesChecked || 0) + ' 個來源，有效優惠 ' + (s.activeDeals || 0) + ' 條（待核實 ' + (s.pending || 0) + '）';
  const text = [head].concat(parts, dashboardUrl ? ['看板：' + dashboardUrl] : []).join('\n\n');
  return text.length > 3900 ? text.slice(0, 3900) + '\n…（內容過長已截斷）' : text;
}

/** 發 Telegram 訊息。回傳 {sent, error?}，不丟例外，通知失敗不該讓掃描失敗。 */
export async function sendTelegram(token, chatId, text) {
  if (!token || !chatId) return {sent: false, error: '未設定 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID'};
  if (!text) return {sent: false};
  try {
    const res = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({chat_id: chatId, text, disable_web_page_preview: true}),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return {sent: false, error: 'Telegram HTTP ' + res.status};
    return {sent: true};
  } catch (error) {
    return {sent: false, error: String(error && error.message ? error.message : error)};
  }
}

/** 掃描完呼叫：組訊息、發送，回傳要記進 last-run 的結果。 */
export async function notifyScan(result, env) {
  const text = buildDigest(result.events, result.lastRun, env.DASHBOARD_URL);
  if (!text) return {sent: false, reason: '本輪沒有需要通知的事'};
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return {sent: false, reason: '未設定 Telegram，略過通知'};
  return sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text);
}
