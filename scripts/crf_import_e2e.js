/* crf_import_e2e.js — 服装导入的端到端验证（真浏览器 + 真上传 + 真穿）。
 *
 * 为什么要它：单元回归只证明「校验规则对」，证明不了「导入之后人物还画得出来」。
 * 这一步把官方皮肤打成 ZIP，通过 file input 上传，再切到那件衣服截图核对。
 *
 * 用法: node scripts/serve.py（另开终端）后 node scripts/crf_import_e2e.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { puppeteer, SHOTS } = require('./_probe_env');

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SKIN = path.join(ROOT, 'web/assets/spine/crf_chr_002/crf_skn_002_0005_01');
const TMP = path.join(ROOT, 'temp');
const ZIP_OUT = path.join(TMP, 'import-test-crf.zip');

/* ---- 造 ZIP（store 法，零依赖）---- */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const name of Object.keys(files)) {
    const data = files[name];
    const nb = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nb.length, 26);
    chunks.push(local, nb, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 10); cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nb.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nb]));
    offset += local.length + nb.length + data.length;
  }
  const cdb = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdb.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(chunks), cdb, eocd]);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  const base = path.basename(SKIN);
  const files = {};
  ['atlas', 'png', 'skel'].forEach(ext => {
    files[base + '.' + ext] = fs.readFileSync(path.join(SKIN, base + '.' + ext));
  });
  files[base + '_gesture.json'] = fs.readFileSync(path.join(SKIN, base + '_gesture.json'));
  fs.writeFileSync(ZIP_OUT, makeZip(files));
  console.log('测试 ZIP: ' + ZIP_OUT + ' (' + fs.statSync(ZIP_OUT).size + ' B)');

  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
    defaultViewport: { width: 440, height: 900, deviceScaleFactor: 2 }
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('[err] ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('[con] ' + m.text()); });

  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'load', timeout: 40000 });
  await sleep(2500);

  /* 进游戏：跳过标题与序章问卷 */
  await page.evaluate(() => {
    const b = document.getElementById('btn-title-start') ||
      [...document.querySelectorAll('button')].find(x => /はじめる|开始|Start/i.test(x.textContent));
    if (b) b.click();
  });
  await sleep(1800);
  for (let i = 0; i < 4; i++) {
    const r = await page.evaluate(() => {
      const c = [...document.querySelectorAll('button, .onb-choice, .ob-btn')];
      const skip = c.find(b => /^\s*(跳过|スキップ|Skip)\s*$/.test(b.textContent));
      if (skip) { skip.click(); return 1; }
      const nx = c.find(b => /^\s*(下一步|次へ|Next)\s*$/.test(b.textContent));
      if (nx) { nx.click(); return 1; }
      return 0;
    });
    if (!r) break;
    await sleep(1000);
  }

  /* 打开服装页 */
  await page.evaluate(() => { if (window.App && App.showView) App.showView('skin'); });
  await sleep(1200);

  /* 上传 ZIP（走真实的 file input 事件链） */
  const input = await page.$('#crf-file-zip');
  if (!input) { console.log('FAIL: 找不到 #crf-file-zip'); await browser.close(); process.exit(1); }
  await input.uploadFile(ZIP_OUT);
  await sleep(4000);

  const afterImport = await page.evaluate(() => {
    const imported = (window.CrfStore ? CrfStore.list() : []);
    const cards = [...document.querySelectorAll('.skin-card')].map(c => c.textContent);
    return { imported: imported.map(x => x.id), cards, skin: window.Config ? Config.section('state').skin : null };
  });
  console.log('导入后: ' + JSON.stringify(afterImport));

  /* 穿上看效果 */
  const worn = await page.evaluate(() => {
    const id = (window.CrfStore ? CrfStore.list() : []).slice(-1)[0];
    if (!id) return { ok: false };
    return new Promise(res => {
      Avatar.loadSkin(id.id, function (err) {
        res({ ok: !err, loaded: Avatar._loadedSkelId, err: err ? err.message : null });
      });
    });
  });
  console.log('穿着结果: ' + JSON.stringify(worn));
  await sleep(2500);

  await page.evaluate(() => {
    if (window.App && App.showView) App.showView('talk');
  });
  await sleep(2000);
  const out = path.join(SHOTS, 'old-imported-skin.png');
  await page.screenshot({ path: out });
  console.log('截图: ' + out);

  const finalState = await page.evaluate(() => ({
    loaded: window.Avatar ? Avatar._loadedSkelId : null,
    ready: !!(window.Avatar && Avatar.avatar && Avatar.avatar.ready),
    pages: (window.Avatar && Avatar.avatar && Avatar.avatar._atlas)
      ? Avatar.avatar._atlas.pages.map(p => p.name) : null
  }));
  console.log('最终状态: ' + JSON.stringify(finalState));

  if (errs.length) console.log(errs.slice(0, 8).join('\n'));
  await browser.close();

  const good = afterImport.imported.length === 1 && worn.ok && finalState.loaded === base;
  console.log(good ? 'E2E PASS' : 'E2E FAIL');
  process.exit(good ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
