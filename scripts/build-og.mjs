#!/usr/bin/env node
/**
 * 重新產生 OG image（社群分享預覽圖，1200×630）。
 *   node scripts/build-og.mjs
 * 讀 worker/og/og.html，用 Playwright 的 Chromium 截圖，輸出：
 *   worker/og/og.png        圖片本身，方便直接看
 *   worker/src/og-image.js  同一張圖的 base64，Worker 的 /og.png 路由用它（不需要額外的靜態資源設定）
 * 平常不用跑：只有改 og.html 才要重新產生，並把兩個輸出檔一起提交。
 * 需要 Playwright（npm i -D playwright 或全域安裝）與中文字型；og.html 預設用「WenQuanYi Zen Hei」，
 * 在別的機器上沒有這個字型時會退到系統的其他中文字型，字重與字距會不同，改圖前先看渲染結果。
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execSync} from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.join(root, 'worker/og/og.html');
const pngPath = path.join(root, 'worker/og/og.png');
const jsPath = path.join(root, 'worker/src/og-image.js');

async function loadPlaywright() {
  try { return await import('playwright'); } catch (e) { /* 試全域安裝 */ }
  const globalRoot = execSync('npm root -g').toString().trim();
  return createRequire(globalRoot + '/')('playwright');
}

const {chromium} = await loadPlaywright();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({viewport: {width: 1200, height: 630}, deviceScaleFactor: 1});
  await page.goto('file://' + htmlPath);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({path: pngPath});
} finally {
  await browser.close();
}

const png = fs.readFileSync(pngPath);
const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (!png.subarray(0, 8).equals(signature)) throw new Error('輸出不是 PNG');
const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
if (width !== 1200 || height !== 630) throw new Error('尺寸應為 1200×630，實際 ' + width + '×' + height);

fs.writeFileSync(jsPath, '// 由 scripts/build-og.mjs 從 worker/og/og.html 產生，不要手改；要改圖請改 og.html 後重新執行腳本。\n' +
  "export const OG_IMAGE_BASE64 = '" + png.toString('base64') + "';\n");
console.log('[og] ' + width + '×' + height + ' PNG ' + Math.round(png.length / 1024) + ' KB → worker/og/og.png、worker/src/og-image.js');
