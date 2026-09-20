/* old-shots.js — 旧项目的截图走查（用真实 UI 流程，不靠 JS 硬切视图）。
 *
 * 为什么要有它：本项目的界面状态由 App/Onboarding 自己管，
 * 直接用 evaluate 改 class 会拍到错误的画面（第一次就拍成了标题页）。
 * 这里点真实按钮，走和玩家一样的路径。
 *
 * 用法: node scripts-old-shots.js <目标> [宽x高]
 * 目标: worldmap | talk | welcome
 */
'use strict';
const { puppeteer, SHOTS } = require('./_probe_env');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = SHOTS;
const target = process.argv[2] || 'worldmap';
const size = (process.argv[3] || '440x900').split('x').map(Number);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
    defaultViewport: { width: size[0], height: size[1], deviceScaleFactor: 2 }
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('[err] ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('[con] ' + m.text()); });

  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'load', timeout: 40000 });
  await sleep(2500);

  /* 1) 标题页：点「はじめる」（文本在不同语言下不同，用 id 或文本兜底） */
  const started = await page.evaluate(() => {
    const btn = document.getElementById('btn-title-start')
      || [...document.querySelectorAll('button')].find(b => /はじめる|开始|Start/i.test(b.textContent));
    if (btn) { btn.click(); return true; }
    return false;
  });
  await sleep(2000);

  /* 2) 序章问卷会挡在中间：先把「跳过」点掉（只在本次会话生效） */
  for (let i = 0; i < 4; i++) {
    const clicked = await page.evaluate(() => {
      const cands = [...document.querySelectorAll('button, .onb-choice, .ob-btn')];
      const skip = cands.find(b => /^\s*(跳过|スキップ|Skip)\s*$/.test(b.textContent));
      if (skip) { skip.click(); return 'skip'; }
      const next = cands.find(b => /^\s*(下一步|次へ|Next)\s*$/.test(b.textContent));
      if (next) { next.click(); return 'next'; }
      return null;
    });
    if (!clicked) break;
    await sleep(1200);
  }
  await sleep(1500);

  /* 3) 进世界页。按钮链路依赖侧边菜单的开关状态（自动化里不稳定），
     这里调用按钮自己调的同一个入口 App.showView('world')。 */
  await page.evaluate(() => {
    if (window.App && App.showView) App.showView('world');
  });
  await sleep(1800);
  /* 进世界页后把抽屉/侧栏收掉，否则它们盖在截图上 */
  await page.evaluate(() => {
    ['drawer', 'side-menu', 'side-overlay'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) { el.classList.add('hidden'); el.classList.remove('open'); el.style.display = 'none'; }
    });
  });
  await sleep(900);

  /* 4) 切到地图模式 */
  if (target === 'worldmap') {
    await page.evaluate(() => {
      const b = document.getElementById('btn-world-mode');
      if (b) b.click();
    });
    await sleep(1500);
    /* 全图视角：复位到 zoom=1，展示整张区域图与所有钉子 */
    await page.evaluate(() => { if (window.WorldMap) WorldMap.reset(); });
    await sleep(800);
  }
  if (target === 'worldmap-focus') {
    await page.evaluate(() => {
      const b = document.getElementById('btn-world-mode');
      if (b) b.click();
    });
    await sleep(1200);
    /* 聚焦：点第一个钉子（会应用官方标定的聚焦缩放） */
    await page.evaluate(() => {
      const pin = document.querySelector('.wmp-pin');
      if (pin) pin.click();
    });
    await sleep(1200);
  }

  /* 拍前再确认一次视图：showView 是幂等的，重复调用无害，
     但能挡住「某处把视图切回对话页」这种时序问题。 */
  await page.evaluate(() => {
    if (window.App && App.showView) App.showView('world');
  });
  await sleep(800);

  /* 调试：看清哪一步把视图换回去了 */
  const dbg = await page.evaluate(() => {
    const active = [...document.querySelectorAll('.view')].filter(v => v.classList.contains('active')).map(v => v.id);
    const wv = document.getElementById('view-world');
    const st = wv ? getComputedStyle(wv) : null;
    const r = wv ? wv.getBoundingClientRect() : null;
    return { active, tutorial: !!(window.App && App._inTutorial),
             mode: window.WorldMap ? WorldMap.mode : null,
             worldBox: r ? [Math.round(r.width), Math.round(r.height), r.top | 0] : null,
             worldDisplay: st ? st.display : null, worldZ: st ? st.zIndex : null,
             pin: (function () {
               const pin = document.querySelector('.wmp-pin img');
               if (!pin) return null;
               const cs = getComputedStyle(pin);
               const r = pin.getBoundingClientRect();
               return { css: [cs.width, cs.height], box: [Math.round(r.width), Math.round(r.height)],
                        nat: [pin.naturalWidth, pin.naturalHeight] };
             })() };
  });
  console.log('DBG ' + JSON.stringify(dbg));

  const file = path.join(OUT, 'old-' + target + '.png');
  await page.screenshot({ path: file });

  const info = await page.evaluate(() => {
    const w = document.getElementById('view-world');
    const r = document.getElementById('world-fields');
    return {
      worldVisible: w ? !w.classList.contains('hidden') : null,
      mode: r ? r.className : null,
      pins: r ? r.querySelectorAll('.wmp-pin').length : -1,
      plate: r && r.querySelector('.wmp-plate') ? r.querySelector('.wmp-plate').naturalWidth : null,
      zoom: window.WorldMap ? window.WorldMap.zoom.toFixed(2) : null
    };
  });
  console.log(JSON.stringify({ started, ...info }));
  if (errs.length) console.log(errs.slice(0, 8).join('\n'));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
