/* shot-talk.js — 拍对话页（用来核对缩放按钮与相机缩放效果）。
   用法: node scripts/shot-talk.js [zoom步数]
*/
'use strict';
const { puppeteer, SHOTS } = require('./_probe_env');
const fs = require('fs');
const OUT = SHOTS;
const steps = Number(process.argv[2] || 0);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
    defaultViewport: { width: 440, height: 900, deviceScaleFactor: 2 }
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('[err] ' + e.message));
  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'load', timeout: 40000 });
  await sleep(2500);
  await page.evaluate(() => {
    const b = document.getElementById('btn-title-start') ||
      [...document.querySelectorAll('button')].find(x => /はじめる|开始|Start/i.test(x.textContent));
    if (b) b.click();
  });
  await sleep(1800);
  for (let i = 0; i < 4; i++) {
    const r = await page.evaluate(() => {
      const c = [...document.querySelectorAll('button, .onb-choice, .ob-btn')];
      const s = c.find(b => /^\s*(跳过|スキップ|Skip)\s*$/.test(b.textContent));
      if (s) { s.click(); return 1; }
      const n = c.find(b => /^\s*(下一步|次へ|Next)\s*$/.test(b.textContent));
      if (n) { n.click(); return 1; }
      return 0;
    });
    if (!r) break;
    await sleep(1000);
  }
  await page.evaluate(() => { if (window.App && App.showView) App.showView('talk'); });
  await sleep(1500);
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => { if (window.Avatar && Avatar.zoomBy) Avatar.zoomBy(0.25); });
    await sleep(400);
  }
  await sleep(1500);
  const st = await page.evaluate(() => ({
    zoom: window.Avatar && Avatar.playerZoom ? Avatar.playerZoom() : null,
    view: window.Avatar ? window.Avatar._view : null,
    btns: ['btn-zoom-in', 'btn-zoom-out', 'btn-zoom-reset'].map(id => !!document.getElementById(id))
  }));
  const file = OUT + '/old-talk-zoom' + steps + '.png';
  await page.screenshot({ path: file });
  console.log(JSON.stringify({ file, ...st }));
  if (errs.length) console.log(errs.slice(0, 5).join('\n'));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
