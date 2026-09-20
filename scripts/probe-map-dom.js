/* probe-map-dom.js — 纯文本探针：报告地图在 DOM 里的真实状态（不截图）。
 *
 * 为什么用文本而不是截图：这条链路上截图读取会触发上游 400，
 * 而「缺什么」完全可以用元素计数/尺寸/样式报出来。
 *
 * 用法: 起 serve.py 后 node scripts/probe-map-dom.js
 */
'use strict';
const { puppeteer } = require('./_probe_env');
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
  page.on('pageerror', e => errs.push('[err] ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push('[con] ' + m.text()); });

  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'load', timeout: 40000 });
  await sleep(2500);
  await page.evaluate(() => { const b = document.getElementById('btn-title-start'); if (b) b.click(); });
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
  await page.evaluate(() => { App.showView('world'); });
  await sleep(1000);
  await page.evaluate(() => { const b = document.getElementById('btn-world-mode'); if (b) b.click(); });
  await sleep(1500);

  function snapshot() {
    const q = (s) => document.querySelectorAll(s).length;
    const box = (s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { w: Math.round(r.width), h: Math.round(r.height),
               x: Math.round(r.x), y: Math.round(r.y),
               display: cs.display, vis: cs.visibility, op: cs.opacity, z: cs.zIndex };
    };
    const visiblePins = [...document.querySelectorAll('.wmp-pin')].filter(p => {
      const r = p.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).length;
    return {
      level: window.WorldMap ? WorldMap.level : null,
      mode: window.WorldMap ? WorldMap.mode : null,
      area: window.WorldMap ? WorldMap.areaId : null,
      zoom: window.WorldMap ? Math.round(WorldMap.zoom * 100) / 100 : null,
      counts: {
        map: q('.wmp-map'), layer: q('.wmp-layer'), plate: q('.wmp-plate'),
        top: q('.wmp-top'), bar: q('.wmp-bar'), select: q('.wmp-select'),
        locate: q('.wmp-locate'), ctl: q('.wmp-ctl'),
        pins: q('.wmp-pin'), areaPins: q('.wmp-area-pin'), stagePins: q('.wmp-stage-pin'),
        names: q('.wmp-name'), me: q('.wmp-me'), ring: q('.wmp-ring'), sheet: q('.wmp-sheet')
      },
      visiblePins,
      boxes: {
        map: box('.wmp-map'), plate: box('.wmp-plate'), top: box('.wmp-top'),
        bar: box('.wmp-bar'), select: box('.wmp-select'), ctl: box('.wmp-ctl')
      },
      plateLoaded: (() => {
        const i = document.querySelector('.wmp-plate');
        return i ? { nat: [i.naturalWidth, i.naturalHeight], src: i.getAttribute('src') } : null;
      })(),
      worldBody: (() => {
        const w = document.getElementById('world-fields');
        if (!w) return null;
        const r = w.getBoundingClientRect();
        const cs = getComputedStyle(w);
        return { cls: w.className, w: Math.round(r.width), h: Math.round(r.height),
                 overflowY: cs.overflowY, display: cs.display };
      })()
    };
  }

  console.log('--- 区域级（进入后的默认）');
  console.log(JSON.stringify(await page.evaluate(snapshot), null, 1));

  /* 进地点级：点第一个 field 钉子（用真鼠标，因为之前有 pointer capture 吞点击的问题） */
  const pin = await page.evaluate(() => {
    const p = document.querySelector('.wmp-pin');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  if (pin) { await page.mouse.click(pin.x, pin.y); await sleep(1500); }
  console.log('--- 地点级（点了一个 field 之后）');
  console.log(JSON.stringify(await page.evaluate(snapshot), null, 1));

  /* 弹层 */
  await page.evaluate(() => { const b = document.querySelector('.wmp-select'); if (b) b.click(); });
  await sleep(1000);
  console.log('--- 区域弹层');
  console.log(JSON.stringify(await page.evaluate(() => {
    const q = (s) => document.querySelectorAll(s).length;
    const sh = document.querySelector('.wmp-sheet');
    const r = sh ? sh.getBoundingClientRect() : null;
    return {
      sheet: q('.wmp-sheet'), cards: q('.wmp-sheet-card'), heads: q('.wmp-sheet-head'),
      size: r ? [Math.round(r.width), Math.round(r.height)] : null,
      firstCardText: (document.querySelector('.wmp-sheet-card') || {}).innerText || null
    };
  }), null, 1));

  if (errs.length) console.log('错误: ' + errs.slice(0, 6).join(' | '));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
