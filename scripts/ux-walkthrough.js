/* ux-walkthrough.js — 用户体验走查：按真实操作路径走一遍，逐屏截图并记录卡点。
 *
 * 为什么这么做：回归只证明「行为没坏」，证明不了「用起来顺不顺」。
 * 这个脚本模拟玩家从启动到各个页面的动作，每步截图 + 记录耗时/异常/空状态，
 * 输出一份可核对的走查记录（而不是靠印象说「体验还行」）。
 *
 * 用法: 起 serve.py 后 node scripts/ux-walkthrough.js
 */
'use strict';
const { puppeteer, SHOTS } = require('./_probe_env');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = path.join(SHOTS, 'ux');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const steps = [];
function note(name, detail) { steps.push({ name, ...detail }); console.log('  · ' + name + ' ' + JSON.stringify(detail)); }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
    defaultViewport: { width: 440, height: 900, deviceScaleFactor: 2 }
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('[err] ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push('[con] ' + m.text()); });

  const t0 = Date.now();
  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'load', timeout: 40000 });
  await sleep(2500);

  /* 1. 标题页 */
  await page.screenshot({ path: OUT + '/01-title.png' });
  const title = await page.evaluate(() => {
    const btn = document.getElementById('btn-title-start');
    const r = btn ? btn.getBoundingClientRect() : null;
    return {
      hasStart: !!btn,
      startLabel: btn ? btn.textContent.trim() : null,
      startSize: r ? [Math.round(r.width), Math.round(r.height)] : null,
      touchTargetOk: r ? (r.height >= 44) : null
    };
  });
  note('标题页', title);

  /* 2. 序章问卷（记步数与文案，判断是否太长） */
  const clicks = [];
  await page.evaluate(() => {
    const b = document.getElementById('btn-title-start');
    if (b) b.click();
  });
  await sleep(1800);
  for (let i = 0; i < 8; i++) {
    const info = await page.evaluate(() => {
      const panel = document.querySelector('.onb-panel, #onb-panel, .onboarding');
      const h = panel ? (panel.querySelector('h3, .onb-title') || {}).textContent : null;
      const btns = [...document.querySelectorAll('button, .onb-choice, .ob-btn')]
        .map(b => b.textContent.trim()).filter(Boolean).slice(0, 6);
      return { title: h ? h.trim() : null, buttons: btns };
    });
    if (!info.title && !info.buttons.length) break;
    clicks.push(info);
    const moved = await page.evaluate(() => {
      const c = [...document.querySelectorAll('button, .onb-choice, .ob-btn')];
      const nx = c.find(b => /^\s*(跳过|スキップ|Skip)\s*$/.test(b.textContent));
      if (nx) { nx.click(); return 'skip'; }
      const n2 = c.find(b => /^\s*(下一步|次へ|Next)\s*$/.test(b.textContent));
      if (n2) { n2.click(); return 'next'; }
      return null;
    });
    if (!moved) break;
    await sleep(1000);
  }
  await page.screenshot({ path: OUT + '/02-onboarding.png' });
  note('序章问卷', { screensSeen: clicks.length, first: clicks[0] || null, last: clicks[clicks.length - 1] || null });

  /* 3. 对话页：主界面元素是否齐全 */
  await sleep(1500);
  const talk = await page.evaluate(() => {
    const q = s => !!document.querySelector(s);
    const roundBtns = [...document.querySelectorAll('#quick-btns .round-btn')].map(b => ({
      id: b.id, label: b.textContent.trim(), hidden: b.classList.contains('hidden'),
      h: Math.round(b.getBoundingClientRect().height)
    }));
    return {
      hasInput: q('#input'), hasSend: q('#btn-send'), hasLog: q('#log-panel'),
      hasBubble: q('#bubble'), hasHud: q('#hud-place'),
      modeLabel: (document.getElementById('log-sub') || {}).textContent,
      quickButtons: roundBtns
    };
  });
  await page.screenshot({ path: OUT + '/03-talk.png' });
  note('对话页', talk);

  /* 4. 各面板可达性：点侧栏/抽屉里的每一项，看有没有空页/报错 */
  const views = ['welcome', 'daily', 'quest', 'alarm', 'chara', 'memory', 'skin', 'world', 'settings'];
  for (const v of views) {
    const r = await page.evaluate((name) => {
      if (!window.App || !App.showView) return { ok: false };
      App.showView(name);
      const el = document.getElementById('view-' + name);
      const body = el ? el.innerText.trim() : '';
      return {
        ok: !!(el && el.classList.contains('active')),
        textLen: body.length,
        empty: body.length < 10,
        firstLine: body.split(String.fromCharCode(10)).filter(Boolean)[0] || ''
      };
    }, v);
    await sleep(900);
    await page.screenshot({ path: OUT + '/04-' + v + '.png' });
    note('面板:' + v, r);
  }

  /* 5. 发一条消息（看打字/回话链路是否有反馈；没有配端点时应给出可理解的提示） */
  await page.evaluate(() => { App.showView('talk'); });
  await sleep(800);
  const chat = await page.evaluate(() => {
    const input = document.getElementById('input');
    if (!input) return { ok: false };
    input.value = 'こんにちは';
    const send = document.getElementById('btn-send');
    if (send) send.click();
    return { ok: true };
  });
  await sleep(2500);
  const chatAfter = await page.evaluate(() => ({
    toast: (document.getElementById('toast') || {}).textContent || '',
    bubble: (document.getElementById('bubble') || {}).textContent || '',
    bubbleVisible: !!(document.getElementById('bubble') &&
                      !document.getElementById('bubble').classList.contains('hidden'))
  }));
  await page.screenshot({ path: OUT + '/05-send.png' });
  note('发送消息（未配端点）', { clicked: chat.ok, ...chatAfter });

  /* 6. 移动端宽度下的布局（360px） */
  await page.setViewport({ width: 360, height: 780, deviceScaleFactor: 2 });
  await sleep(1200);
  await page.evaluate(() => { App.showView('talk'); });
  await sleep(800);
  const narrow = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    quickBtnsVisible: [...document.querySelectorAll('#quick-btns .round-btn')]
      .filter(b => !b.classList.contains('hidden')).length
  }));
  await page.screenshot({ path: OUT + '/06-narrow.png' });
  note('窄屏 360px', narrow);

  const total = Date.now() - t0;
  console.log('');
  console.log('走查用时 ' + (total / 1000).toFixed(1) + 's，异常 ' + errs.length + ' 条');
  if (errs.length) errs.slice(0, 10).forEach(e => console.log('  ' + e));

  fs.writeFileSync(OUT + '/walkthrough.json', JSON.stringify({ steps, errors: errs }, null, 1));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
