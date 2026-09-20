/* probe-map-labels.js — 判定钉子地名/「目前位置」到底是「没字」还是「被样式吃掉」。
   做法：直接读 DOM 文本 + 计算后的盒子尺寸（不截图）。
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
  await sleep(900);
  await page.evaluate(() => { const b = document.getElementById('btn-world-mode'); if (b) b.click(); });
  await sleep(1500);

  const area = await page.evaluate(() => {
    const info = (el, label) => {
      if (!el) return { label, missing: true };
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        label,
        text: (el.textContent || '').trim().slice(0, 24),
        html: el.innerHTML.slice(0, 60),
        box: [Math.round(r.width), Math.round(r.height)],
        pos: [Math.round(r.x), Math.round(r.y)],
        color: cs.color, bg: cs.backgroundColor, fontSize: cs.fontSize,
        display: cs.display, opacity: cs.opacity, visibility: cs.visibility
      };
    };
    const pins = [...document.querySelectorAll('.wmp-pin')];
    const first = pins[0];
    const names = first ? first.querySelector('.wmp-name') : null;
    const mark = first ? first.querySelector('.wmp-mark') : null;
    const me = document.querySelector('.wmp-me');
    // 也看 World.placeLabel 的实际返回值
    const f = window.World && World.areas ? World.areas()[0].fields[0] : null;
    return {
      pinCount: pins.length,
      firstPin: info(first, 'firstPin'),
      nameEl: info(names, 'nameEl'),
      markEl: info(mark, 'markEl'),
      meEl: info(me, 'meEl'),
      meBadge: info(document.querySelector('.wmp-me-badge'), 'meBadge'),
      meFaceImg: info(document.querySelector('.wmp-me-face img'), 'meFaceImg'),
      labelProbe: f ? {
        id: f.id, rawName: f.name,
        placeLabel: (function () { try { return World.placeLabel(f.id, f.name); } catch (e) { return 'ERR:' + e.message; } })(),
        i18nHas: !!(window.I18n && I18n.tc && I18n.tc('place.' + f.id, '') !== '')
      } : null,
      sampleNames: pins.slice(0, 4).map(p => (p.querySelector('.wmp-name') || {}).textContent || '')
    };
  });
  console.log('=== 区域级');
  console.log(JSON.stringify(area, null, 1));

  /* 进地点级 */
  const pinPos = await page.evaluate(() => {
    const p = document.querySelector('.wmp-pin');
    const r = p.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  await page.mouse.click(pinPos.x, pinPos.y);
  await sleep(1600);
  const field = await page.evaluate(() => {
    const pins = [...document.querySelectorAll('.wmp-pin')];
    return {
      level: WorldMap.level, fieldId: WorldMap.fieldId, zoom: WorldMap.zoom,
      pinCount: pins.length,
      samples: pins.slice(0, 6).map(p => {
        const r = p.getBoundingClientRect();
        return {
          name: (p.querySelector('.wmp-name') || {}).textContent || '',
          at: [Math.round(r.x), Math.round(r.y)],
          onScreen: r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight,
          id: p.dataset.stage || p.dataset.field || ''
        };
      }),
      stageOffsets: Object.keys(WorldMap.stageOffsets || {}).length,
      fieldOfStage: (function () { try { return WorldMap.fieldOfStage(Config.section('state').stage); } catch (e) { return 'ERR'; } })()
    };
  });
  console.log('=== 地点级');
  console.log(JSON.stringify(field, null, 1));

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
