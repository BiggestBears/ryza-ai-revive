/* verify-map-coverage.js — 核对「每个区域都能选到地点」。
 *
 * 为什么单写一个：原来的问题是**只有 area_01 的一两个 field 有标定坐标**，
 * 其余区域进二级后一个钉子都没有（选不了地点）。这个脚本逐个区域、
 * 逐个 field 走一遍，报出「钉子数 / 标定数 / 兜底数」，并确认钉子都在屏内。
 *
 * 纯文本输出（不截图）。
 * 用法: 起 serve.py 后 node scripts/verify-map-coverage.js
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
  page.on('pageerror', e => errs.push(e.message));

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
    await sleep(900);
  }
  await page.evaluate(() => { App.showView('world'); });
  await sleep(800);
  await page.evaluate(() => { const b = document.getElementById('btn-world-mode'); if (b) b.click(); });
  await sleep(1200);

  const areas = await page.evaluate(() => World.areas().map(a => a.id));
  let bad = 0;

  for (const areaId of areas) {
    /* 切到该区域 */
    const areaInfo = await page.evaluate((aid) => {
      WorldMap.areaId = aid;
      WorldMap.reset();
      WorldMap.level = 'area';
      WorldMap.render(document.getElementById('world-fields'), Config.section('state'));
      const pins = [...document.querySelectorAll('.wmp-pin')];
      const onScreen = pins.filter(p => {
        const r = p.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.left >= -20 && r.top >= -20 &&
               r.right <= innerWidth + 20 && r.bottom <= innerHeight + 20;
      }).length;
      return {
        area: aid,
        fieldPins: pins.length,
        calibrated: pins.filter(p => p.dataset.calibrated === '1').length,
        fallback: pins.filter(p => p.dataset.calibrated === '0').length,
        onScreen,
        fieldsTotal: WorldMap.fieldsOf(aid).length
      };
    }, areaId);

    /* 进第一个 field 看二级 */
    const stageInfo = await page.evaluate(() => {
      const p = document.querySelector('.wmp-pin');
      if (!p) return null;
      const f = p.dataset.field;
      WorldMap.enterField(f, Config.section('state').stage);
      const pins = [...document.querySelectorAll('.wmp-pin')];
      const onScreen = pins.filter(q => {
        const r = q.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.left >= -20 && r.top >= -20 &&
               r.right <= innerWidth + 20 && r.bottom <= innerHeight + 20;
      }).length;
      return {
        field: f,
        stagePins: pins.length,
        calibrated: pins.filter(q => q.dataset.calibrated === '1').length,
        fallback: pins.filter(q => q.dataset.calibrated === '0').length,
        onScreen,
        stagesTotal: WorldMap.stagesOf(f).length,
        namesSample: pins.slice(0, 3).map(q => (q.querySelector('.wmp-name') || {}).textContent || '')
      };
    });

    const okArea = areaInfo.fieldPins === areaInfo.fieldsTotal && areaInfo.onScreen === areaInfo.fieldPins;
    const okStage = !!stageInfo && stageInfo.stagePins === stageInfo.stagesTotal &&
                    stageInfo.onScreen === stageInfo.stagePins;
    if (!okArea || !okStage) bad++;

    console.log('%s: field 钉 %d/%d（标定 %d/兜底 %d，屏内 %d）%s',
      areaInfo.area, areaInfo.fieldPins, areaInfo.fieldsTotal,
      areaInfo.calibrated, areaInfo.fallback, areaInfo.onScreen, okArea ? '' : '  ✘ field 不全');
    if (stageInfo) {
      console.log('    └ 二级 %s: stage 钉 %d/%d（标定 %d/兜底 %d，屏内 %d）%s  样例=%s',
        stageInfo.field, stageInfo.stagePins, stageInfo.stagesTotal,
        stageInfo.calibrated, stageInfo.fallback, stageInfo.onScreen,
        okStage ? '' : '  ✘ stage 不全', JSON.stringify(stageInfo.namesSample));
    } else {
      console.log('    └ 二级：进不去（没有 field 钉子）  ✘');
    }
  }

  if (errs.length) console.log('页面错误: ' + errs.slice(0, 5).join(' | '));
  console.log(bad === 0 ? '\n全覆盖 ✔ 每个区域的每个 field / stage 都能点到'
                        : '\n有 ' + bad + ' 个区域仍不完整 ✘');
  await browser.close();
  process.exit(bad === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
