/* probe-ui.js — 走查特定界面状态：侧栏展开、坐姿、地图模式。
   用法: node scripts/probe-ui.js <side|sit|map>
*/
'use strict';
const { puppeteer, SHOTS } = require('./_probe_env');
const fs = require('fs');
const OUT = SHOTS;
const what = process.argv[2] || 'side';
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
    await sleep(900);
  }
  await page.evaluate(() => { if (window.App && App.showView) App.showView('talk'); });
  await sleep(1200);

  if (what === 'side') {
    await page.evaluate(() => {
      const b = document.getElementById('btn-expand');
      if (b) b.click();
    });
    await sleep(1200);
  }
  if (what === 'sit') {
    await page.evaluate(() => {
      if (window.Avatar && Avatar.setPosture) Avatar.setPosture('posture_sitting');
      const b = document.getElementById('btn-posture');
      if (b && !b.classList.contains('hidden')) b.click();
    });
    await sleep(2000);
    /* 也把相机的“色块”位置记录下来 */
  }
  if (what === 'map') {
    await page.evaluate(() => { if (window.App) App.showView('world'); });
    await sleep(1200);
    await page.evaluate(() => {
      const b = document.getElementById('btn-world-mode');
      if (b) b.click();
    });
    await sleep(1500);
  }
  const st = await page.evaluate(() => {
    const vis = id => {
      const el = document.getElementById(id);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { display: cs.display, hidden: el.classList.contains('hidden') };
    };
    return {
      posture: window.Avatar ? Avatar.postureKey() : null,
      loadedSkel: window.Avatar ? Avatar._loadedSkelId : null,
      sideOpen: vis('side-menu'),
      drawer: vis('drawer'),
      quickBtns: vis('quick-btns'),
      hud: vis('hud-cluster') || vis('hud'),
      mapMode: window.WorldMap ? WorldMap.mode : null,
      camera: window.Avatar ? window.Avatar._view : null
    };
  });
  const file = OUT + '/probe-' + what + '.png';
  await page.screenshot({ path: file });
  console.log(file);
  console.log(JSON.stringify(st));
  if (errs.length) console.log(errs.slice(0, 5).join('\n'));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
