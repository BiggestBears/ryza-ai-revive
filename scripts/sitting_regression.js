/* 坐姿变体回归（官方 SittingSets / SittingMandatorySlots）。
 *
 * 官方数据事实（由本回归断言，防以后改动或读错字段）：
 *   SittingSets 是 {newId, previousId, weight} 四元组；
 *   **只有「保持当前坐姿」的对是 99999，所有「切换」对都是 0** ⇒ 官方不自动切换；
 *   SittingMandatorySlots 规定 sitting_agura 时 leg 槽必须被驱动。
 *
 * 用法: node scripts/sitting_regression.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GESTURE = path.join(ROOT, 'web/assets/spine/crf_chr_002/crf_skn_002_0001_01/crf_skn_002_0001_01_gesture.json');

let fail = 0;
function ok(c, n) { if (c) console.log('  PASS ' + n); else { fail++; console.log('  FAIL ' + n); } }
function eq(a, b, n) { ok(a === b, n + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

/* ---- 只加载 avatar.js 需要的最小环境 ---- */
const store = {};
const sandbox = {
  console, setTimeout, clearTimeout, Promise, Math, JSON, Date, Object, Array, String, Number,
  isFinite, parseInt, parseFloat, RegExp, Infinity, NaN, Error, Uint8Array, Float32Array,
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; },
                  removeItem: k => { delete store[k]; } },
  document: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {}, createElement: () => ({ style: {}, classList: { add(){}, remove(){} }, appendChild(){}, setAttribute(){} }) },
  navigator: {},
  spine: { Physics: { none: 0, pose: 1, update: 2 }, Skeleton: function () {}, AnimationState: function () {} },
  Image: function () {}, fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  performance: { now: () => Date.now() }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['util.js', 'config.js', 'avatar.js']) {
  if (f === 'config.js' || f === 'util.js') {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/js', f), 'utf8'), sandbox, { filename: f });
  }
}
/* avatar.js 需要 Util；它自己从 window.Util 取，已在上下文里 */
vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/js/avatar.js'), 'utf8'), sandbox, { filename: 'avatar.js' });
const Avatar = sandbox.Avatar;

console.log('# 1. 官方数据自检');
const g = JSON.parse(fs.readFileSync(GESTURE, 'utf8'));
const sets = g.emotionalGesture.SittingSets || [];
const mandatory = g.emotionalGesture.SittingMandatorySlots || [];
eq(sets.length, 4, 'SittingSets 有 4 条');
eq(mandatory.length, 1, 'SittingMandatorySlots 有 1 条');
const switchPairs = sets.filter(x => x.newId !== x.previousId);
ok(switchPairs.length === 2, '两条是切换对（normal→agura / agura→normal）');
ok(switchPairs.every(x => Number(x.weight) === 0),
  '官方把「切换」的权重全设成 0（作者禁用自动切换）');
const stayPairs = sets.filter(x => x.newId === x.previousId);
ok(stayPairs.every(x => Number(x.weight) > 0), '「保持」的权重都 > 0');
eq(mandatory[0].SittingId, 'sitting_agura', '强制槽位属于 sitting_agura');
eq(mandatory[0].SlotId, 'leg', '被强制的槽位是 leg');

console.log('\n# 2. 代码读到的是同一份数据');
Avatar.gesture = g;
eq(Avatar._sittingSets().length, 4, '_sittingSets 读到 4 条');
eq(Avatar._sittingMandatory().length, 1, '_sittingMandatory 读到 1 条');

console.log('\n# 3. 自动切换：官方数据下必须为空');
Avatar._sittingId = 'sitting_normal';
eq(Avatar.sittingAutoTargets().length, 0, 'normal 下没有自动切换目标（权重 0）');
Avatar._sittingId = 'sitting_agura';
eq(Avatar.sittingAutoTargets().length, 0, 'agura 下也没有');

console.log('\n# 4. 反向对照：把权重改成 >0，自动切换必须出现');
{
  const g2 = JSON.parse(JSON.stringify(g));
  g2.emotionalGesture.SittingSets.forEach(x => {
    if (x.newId !== x.previousId) x.weight = 5;
  });
  Avatar.gesture = g2;
  Avatar._sittingId = 'sitting_normal';
  const t = Avatar.sittingAutoTargets();
  eq(t.length, 1, '权重 >0 时出现 1 个自动切换目标');
  eq(t[0].id, 'sitting_agura', '目标是 agura');
  Avatar.gesture = g;   /* 还原 */
}

console.log('\n# 5. 强制槽位随坐姿变化');
Avatar._sittingId = 'sitting_normal';
Avatar._sitSlotCache = null;
eq(Avatar.sittingMandatorySlots().length, 0, 'normal 没有强制槽位');
Avatar.setSittingVariant('sitting_agura', function () {});
eq(Avatar.sittingMandatorySlots().join(','), 'leg', 'agura 强制 leg 槽');
Avatar.setSittingVariant('sitting_normal', function () {});
eq(Avatar.sittingMandatorySlots().length, 0, '切回 normal 后无强制');

console.log('\n# 6. 非法坐姿被拒');
{
  let err = null;
  Avatar.setSittingVariant('no_such_sitting', function (e) { err = e; });
  ok(!!err, '未知坐姿被拒绝');
  eq(Avatar._sittingId, 'sitting_normal', '拒绝后坐姿不变');
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED ' + fail));
process.exit(fail === 0 ? 0 : 1);
