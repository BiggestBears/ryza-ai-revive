/* verify-map-fixes.js — 验证「地图点不动」「切区域回列表」两个修复。
   用真实鼠标事件点钉子（不是 evaluate 调函数），因为原来的 bug 正是
   pointer capture 把真实 click 吞掉了 —— 只有真点击才测得出来。
*/
'use strict';
const path = require('path');
const { puppeteer, SHOTS } = require('./_probe_env');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
    defaultViewport: { width: 440, height: 900, deviceScaleFactor: 2 }
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'load', timeout: 40000 });
  await sleep(2500);
  await page.evaluate(() => {
    const b = document.getElementById('btn-title-start');
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

  /* 进世界页 → 切地图模式 */
  await page.evaluate(() => { App.showView('world'); });
  await sleep(1200);
  await page.evaluate(() => {
    const b = document.getElementById('btn-world-mode');
    if (b) b.click();
  });
  await sleep(1500);

  const before = await page.evaluate(() => ({
    mode: WorldMap.mode,
    area: WorldMap.areaId,
    stage: Config.section('state').stage,
    pins: document.querySelectorAll('.wmp-pin').length
  }));
  console.log('进入地图: ' + JSON.stringify(before));

  /* A) 真鼠标点第二个钉子（第一个可能是当前位置） */
  const pinBox = await page.evaluate(() => {
    const pins = [...document.querySelectorAll('.wmp-pin')];
    const p = pins[1] || pins[0];
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             id: p.dataset.field || p.title };
  });
  console.log('点击钉子: ' + JSON.stringify(pinBox));
  if (pinBox) {
    await page.mouse.click(pinBox.x, pinBox.y);
    await sleep(1200);
  }
  const afterClick = await page.evaluate(() => ({
    stage: Config.section('state').stage,
    zoom: WorldMap.zoom,
    mode: WorldMap.mode,
    worldActive: (document.getElementById('view-world') || {}).classList
      ? document.getElementById('view-world').classList.contains('active') : null
  }));
  const pinWorked = afterClick.zoom > 1.01 || afterClick.stage !== before.stage;
  console.log('点击后: ' + JSON.stringify(afterClick) + '  → ' + (pinWorked ? '钉子生效 ✔' : '钉子没反应 ✘'));

  /* B) 从右侧下拉切区域，应留在地图模式 */
  await page.evaluate(() => {
    const sel = document.getElementById('world-area');
    const opts = [...sel.options].map(o => o.value);
    const other = opts.find(v => v !== sel.value) || opts[0];
    sel.value = other;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return other;
  });
  await sleep(1400);
  const afterArea = await page.evaluate(() => ({
    mode: WorldMap.mode,
    area: WorldMap.areaId,
    cls: (document.getElementById('world-fields') || {}).className,
    pins: document.querySelectorAll('.wmp-pin').length
  }));
  const stayed = afterArea.mode === 'map' && /wmp-on/.test(afterArea.cls || '');
  console.log('切区域后: ' + JSON.stringify(afterArea) + '  → ' + (stayed ? '留在地图 ✔' : '跳回列表 ✘'));

  /* C) 侧栏打开时快捷钮应隐藏 */
  await page.evaluate(() => { App.showView('talk'); });
  await sleep(800);
  await page.evaluate(() => document.getElementById('btn-expand').click());
  await sleep(500);
  const sideState = await page.evaluate(() => {
    const qb = document.getElementById('quick-btns');
    return { sideOpen: document.getElementById('side-menu').classList.contains('open'),
             bodyClass: document.body.classList.contains('side-open'),
             qbOpacity: getComputedStyle(qb).opacity,
             qbPointer: getComputedStyle(qb).pointerEvents };
  });
  const sideOk = sideState.bodyClass && sideState.qbOpacity === '0';
  console.log('侧栏打开: ' + JSON.stringify(sideState) + '  → ' + (sideOk ? '快捷钮让位 ✔' : '仍在叠着 ✘'));

  await page.screenshot({ path: path.join(SHOTS, 'old-map-fixes.png') });
  if (errs.length) console.log('错误: ' + errs.slice(0, 4).join(' | '));

  const ok = pinWorked && stayed && sideOk;
  console.log(ok ? 'ALL FIXED' : 'STILL BROKEN');
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
