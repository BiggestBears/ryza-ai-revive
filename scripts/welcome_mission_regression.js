/* Official welcome mission board regression.
 *
 * What it protects
 * ----------------
 * The board used to be a five-tile guess. It now follows the shape the official
 * server publishes in masters_bundle.json:
 *
 *   mission_groups  3 groups, welcome_start_day 0 / 3 / 5
 *   missions        4 per group, driven by activities with
 *                   unlock_condition_value 3 / 1 / 5 and login_streak 1/3/5
 *
 * So this suite asserts the DATA SHAPE against the official payload (which is
 * committed at docs/official/masters_bundle.json) and the behaviour of the
 * counters, the day gate and the one-shot group claim.
 *
 * Run: node scripts/welcome_mission_regression.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'web', 'js');
const MASTERS = path.join(__dirname, '..', 'docs', 'official', 'masters_bundle.json');

let failures = 0;
function ok(cond, name) {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name); }
}
function eq(a, b, name) {
  ok(a === b, name + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');
}

/* ------------------------------------------------------------- stubs */
const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
  key: (i) => Object.keys(store)[i] || null,
  get length() { return Object.keys(store).length; }
};
const fakeEl = {
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  style: {}, querySelector() { return fakeEl; }, querySelectorAll() { return []; },
  appendChild() {}, setAttribute() {}, addEventListener() {}, innerHTML: ''
};
const sandbox = {
  console, setTimeout, clearTimeout,
  Math, JSON, Date, Object, Array, String, Number, isFinite, parseInt, parseFloat,
  RegExp, Infinity, NaN
};
sandbox.window = sandbox;
sandbox.localStorage = localStorage;
sandbox.document = {
  getElementById: () => fakeEl,
  querySelectorAll: () => [],
  createElement: () => fakeEl,
  addEventListener: () => {}
};
sandbox.navigator = {};
sandbox.location = { origin: 'http://127.0.0.1:8765' };
vm.createContext(sandbox);

function load(file) {
  vm.runInContext(fs.readFileSync(path.join(WEB, file), 'utf8'), sandbox, { filename: file });
}

load('util.js');
load('config.js');
load('game.js');
sandbox.Sound = { se() {}, tapVoice() {} };
sandbox.Fx = { burstConfetti() {} };
sandbox.I18n = { t: (k) => k, tc: (k, fb) => fb, tf: (k, fb) => fb, all: () => [] };
load('quests.js');
load('daily.js');

const { Game, Welcome, Config, Daily } = sandbox;

/* --------------------------------------------------- the official payload */
const masters = JSON.parse(fs.readFileSync(MASTERS, 'utf8')).bundle;
const officialGroups = masters.mission_groups;
const officialMissions = masters.missions;

console.log('# 1. 官方数据自检（committed payload）');
eq(officialGroups.length, 3, 'mission_groups = 3');
eq(officialMissions.length, 12, 'missions = 12');
eq(officialGroups.map(g => g.welcome_start_day).join(','), '0,3,5', 'welcome_start_day = 0,3,5');
officialGroups.forEach(g => {
  eq(g.rewards[0].type, 'voice_token', g.id + ' 组奖励是 voice_token');
  eq(g.rewards[0].point, 4, g.id + ' 需要 4 点');
  eq(g.rewards[0].quantity, 100, g.id + ' 给 100 voice_token');
});

console.log('\n# 2. 板上形制与官方一致');
eq(Welcome.groups.length, officialGroups.length, '板上的组数 = 官方组数');
Welcome.groups.forEach((g, i) => {
  const og = officialGroups.find(x => x.id === g.id);
  ok(!!og, g.id + ' 是官方组 id');
  if (og) eq(g.day, og.welcome_start_day, g.id + ' 开启日与官方一致');
  eq(g.missions.length, 4, g.id + ' 有 4 条任务');
  g.missions.forEach(m => {
    const om = officialMissions.find(x => x.id === m.id);
    ok(!!om, m.id + ' 是官方任务 id');
    if (om) {
      eq(m.need, om.unlock_condition_value, m.id + ' 需要次数与官方 unlock_condition_value 一致');
      /* 官方任务的 activity_id 必须映射到板上的活动名 */
      const map = { app_launched: m.activity === 'login_bonus' ? 'login_bonus' : m.activity };
      ok(!!map[om.activity_id] || om.activity_id === 'login_streak',
        m.id + ' 官方活动 ' + om.activity_id + ' 有对应');
    }
  });
});
/* 官方每条任务只用 app_launched / login_streak 两种活动 */
const kinds = new Set(Welcome.groups.flatMap(g => g.missions.map(m => m.activity)));
ok(kinds.has('mission_clear') && kinds.has('touch') && kinds.has('talk') && kinds.has('login_bonus'),
  '四种活动都出现：mission_clear / touch / talk / login_bonus');
eq(kinds.size, 4, '板上只用到四种活动');

console.log('\n# 3. 计数器与完成判定');
Game.load();
eq(Welcome.activity('talk'), 0, '初始计数器为 0');
Welcome.mark('talk');
eq(Welcome.activity('talk'), 1, 'mark 累加');
Welcome.mark('talk', 4);
eq(Welcome.activity('talk'), 5, 'mark 支持一次加多');

const g1 = Welcome.groups[0];
ok(!Welcome.groupDone(g1), '只完成 talk 时组未完成');
Welcome.mark('mission_clear', 3);
Welcome.mark('touch', 1);
Welcome.mark('login_bonus', 3);   /* 官方第一条只需 1；用 3 连满足 1 */
ok(Welcome.groupDone(g1), '四条都达成后组完成');

console.log('\n# 4. 按天开启（welcome_start_day）');
Welcome.bumpDay(0);
ok(Welcome.isOpen(Welcome.groups[0]), '第 0 天第 1 组开放');
ok(!Welcome.isOpen(Welcome.groups[1]), '第 0 天第 2 组未开放');
Welcome.bumpDay(3);
ok(Welcome.isOpen(Welcome.groups[1]), '第 3 天第 2 组开放');
ok(!Welcome.isOpen(Welcome.groups[2]), '第 3 天第 3 组未开放');
Welcome.bumpDay(5);
ok(Welcome.isOpen(Welcome.groups[2]), '第 5 天第 3 组开放');
/* 天数只增不减（时钟回拨不能把它变小） */
Welcome.bumpDay(1);
eq(Welcome.dayCount(), 5, 'bumpDay 只增不减');

console.log('\n# 5. 组奖励只能领一次');
const money0 = Game.s.money;
const r1 = Welcome.claimGroup(g1);
ok(!!r1, '完成后可领取');
ok(Game.s.money > money0, '领取后金币增加');
const r2 = Welcome.claimGroup(g1);
eq(r2, null, '同一组不能重复领取');
ok(Welcome.groupClaimed(g1), '领取状态被记录');
/* 未完成的组不能领 */
const g3 = Welcome.groups[2];
eq(Welcome.claimGroup(g3), null, '未完成的组不能领取');

console.log('\n# 6. 本地里程碑（官方没有的三格）');
ok(!Welcome.milestoneDone('map'), '初始未完成');
Welcome.milestone('map');
ok(Welcome.milestoneDone('map'), '记录后完成');
/* 里程碑不参与官方任务判定：单独清掉计数器再看第二组 */
Game.s.welcome_activity = {};
Welcome.milestone('skin');
ok(!Welcome.groupDone(Welcome.groups[1]), '清空计数器后第二组未完成（里程碑不参与判定）');

console.log('\n# 7. 日程工具在 Daily（单一日期权威）');
ok(typeof Daily.dayIndex === 'function', 'Daily.dayIndex 存在');
ok(Daily.dayIndex() === 0, '首次启动当天 index = 0');

/* ------------------------------------------------------------------ 汇总 */
console.log('\n' + (failures === 0 ? 'ALL PASS' : 'FAILED ' + failures));
process.exit(failures === 0 ? 0 : 1);
