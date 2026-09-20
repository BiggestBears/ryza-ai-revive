/* 跨模块边界守卫。Run:  node scripts/layering_check.js [--strict]

Why this exists
---------------
The client is 18 plain-global IIFE modules loaded in order by index.html. The
real coupling problem is not any single file being long: it is that `App` is a
hub (10 of 18 modules call back into it), three pairs reference each other in
both directions (config<->avatar, memory<->api, game<->quests), and most
"logic" modules also render DOM directly. Those are exactly the shapes that
produce cross-module regressions, and none of the six behaviour regressions
can see them.

This script freezes the boundaries declared in config/layers.json and reports
where the code currently crosses them. It is deliberately *report-only* by
default so it can be adopted before the refactor; pass --strict (or wire it
into the release flow later) to make violations fail the build.

Checks
  A 层间引用 —— a module may only reference modules in layers it declares
  B 循环依赖 —— no module pair/cycle may reference each other
  C core 纯度 —— core modules must not touch DOM / canvas / network
  D 三端契约 —— the /_proxy contract markers must exist in all three hosts
  E 版本字面量 —— any hard-coded RyzaChat/<x.y.z> must match config/version.json

Nothing here is a guess: every rule in config/layers.json was written against
the measured state of the tree, and anything deliberate-but-coupled is declared
there (allowCycles / coreExceptions) with its rationale instead of being
silently tolerated.
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'web', 'js');
const CONFIG = path.join(ROOT, 'config', 'layers.json');
const STRICT = process.argv.includes('--strict');

const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const LAYERS = cfg.layers;
const MODULES = cfg.modules;
const GLOBALS = cfg.globals;

/* global name -> owning module */
const ownerOf = {};
Object.keys(GLOBALS).forEach(function (m) {
  GLOBALS[m].forEach(function (g) { ownerOf[g] = m; });
});

const problems = [];
function report(section, line) { problems.push({ section: section, line: line }); }

/* Strip comments so a module referenced only in prose doesn't count, while
   keeping `https://…` string literals intact (a naive // strip eats them). */
function stripComments(src) {
  src = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  src = src.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return src;
}

function layerOf(name) {
  const v = MODULES[name];
  if (!v) return null;
  return typeof v === 'string' ? v : v.layer;
}
/* A module may override its layer's dependency list: reality beats theory
   (memory -> io goes through a deliberate injectable seam). */
function mayImportFor(name) {
  const v = MODULES[name];
  if (v && typeof v === 'object' && Array.isArray(v.mayImport)) return v.mayImport;
  const l = layerOf(name);
  return (LAYERS[l] && LAYERS[l].mayImport) || [];
}
function denyRefsFor(name) {
  const l = layerOf(name);
  return (LAYERS[l] && LAYERS[l].denyRefs) || [];
}
function isPlanned(name) {
  const v = MODULES[name];
  return !!(v && typeof v === 'object' && v.planned);
}
function fileOf(name) { return path.join(JS, name + '.js'); }
function moduleExists(name) { return fs.existsSync(fileOf(name)); }

const moduleNames = Object.keys(MODULES).filter(moduleExists);
const plannedMissing = Object.keys(MODULES).filter(function (n) { return isPlanned(n) && !moduleExists(n); });

/* ---------------------------------------------------- A: layer references */
const edges = {};   /* from -> Set(to)   (actual, measured) */
moduleNames.forEach(function (m) { edges[m] = new Set(); });

/* A dependency can hide from the plain `Name.` shape in one specific way: the
   qualified global with no trailing dot, taken as a value —
   `var av = window.Avatar; av.setAtlasVariant(...)`. The alias call itself is
   invisible, and `window.Avatar` has no dot after `Avatar`, so the old pattern
   matched neither: two real violations (nsfw/core -> avatar/render,
   api/io -> avatar/render) sat behind that gap while `--strict` reported 0.
   An assignment target (`global.Name = ...`) is a definition, not a use. */
function stripGlobalAssignments(src) {
  return src.replace(/\b(?:window|global|globalThis|self)\s*\.\s*[A-Za-z_$][\w$]*\s*=(?!=)/g, ' ');
}

const refRe = {};
Object.keys(ownerOf).forEach(function (g) {
  refRe[g] = new RegExp(
    '\\b' + g + '\\s*\\.' +
    '|\\b(?:window|global|globalThis|self)\\s*\\.\\s*' + g + '\\b'
  );
});

moduleNames.forEach(function (m) {
  const src = stripGlobalAssignments(stripComments(fs.readFileSync(fileOf(m), 'utf8')));
  Object.keys(refRe).forEach(function (g) {
    const to = ownerOf[g];
    if (to === m) return;
    if (refRe[g].test(src)) edges[m].add(to);
  });
});

/* Guard-the-guard: the shape this detector reads is the whole point, and it was
   silently narrow for as long as the two leaks existed. If a later edit narrows
   it back, this fails loudly instead of reporting 0 violations again. */
const refProbeBad = (function () {
  const probe = refRe['Avatar'];
  const mustMatch = ['var av = global.Avatar;', 'var av = window.Avatar;',
                     'Avatar.setEmotion("shy");'];
  const mustNotMatch = ['global.Avatar = {};', 'window.Turn = Turn;'];
  const bad = [];
  mustMatch.forEach(function (s) {
    if (!probe.test(stripGlobalAssignments(s))) bad.push('missed: ' + s);
  });
  mustNotMatch.forEach(function (s) {
    if (probe.test(stripGlobalAssignments(s))) bad.push('false positive: ' + s);
  });
  return bad;
})();
if (refProbeBad.length) {
  refProbeBad.forEach(function (b) { report('A', '引用检测自检 ' + b); });
}

console.log('\n=== A. 层间引用 ===');
let aViolations = 0;
moduleNames.forEach(function (m) {
  const fromLayer = layerOf(m);
  const allowed = mayImportFor(m);
  const denied = denyRefsFor(m);
  Array.from(edges[m]).sort().forEach(function (to) {
    const toLayer = layerOf(to);
    if (!toLayer) return;
    const toNames = (GLOBALS[to] || []).concat([to]);
    const hitDeny = toNames.some(function (n) { return denied.indexOf(n) >= 0; });
    if (hitDeny) {
      console.log('  越层(deny) ' + m + '(' + fromLayer + ') -> ' + to + '(' + toLayer + ')');
      aViolations++;
      return;
    }
    if (toLayer === fromLayer) return;
    if (allowed.indexOf(toLayer) < 0) {
      console.log('  越层 ' + m + '(' + fromLayer + ') -> ' + to + '(' + toLayer + ')，该层只允许 ' + (allowed.join('/') || '同层'));
      aViolations++;
    }
  });
});
if (!aViolations && !problems.length) console.log('  PASS 无越层引用');

/* ------------------------------------------------------- B: cycles */
console.log('\n=== B. 循环依赖 ===');
const seen = {};
const stack = [];
const cycles = [];
function dfs(m) {
  seen[m] = 1;
  stack.push(m);
  Array.from(edges[m]).sort().forEach(function (to) {
    if (!edges[to]) return;
    if (seen[to] === 1) {
      cycles.push(stack.slice(stack.indexOf(to)).concat([to]));
    } else if (!seen[to]) {
      dfs(to);
    }
  });
  stack.pop();
  seen[m] = 2;
}
moduleNames.forEach(function (m) { if (!seen[m]) dfs(m); });

/* Dedupe by the set of members, so a->b->a and b->a->b collapse. */
const byKey = {};
cycles.forEach(function (c) {
  const key = Array.from(new Set(c)).sort().join('|');
  if (!byKey[key]) byKey[key] = c;
});
const allowedCycles = (cfg.allowCycles || []).map(function (a) {
  return a.pair.slice().sort().join('|');
});

const hard = [];
const hub = [];
const declared = [];
Object.keys(byKey).forEach(function (key) {
  const c = byKey[key];
  const members = Array.from(new Set(c));
  const asPair = members.slice().sort().join('|');
  if (allowedCycles.indexOf(asPair) >= 0) { declared.push(c); return; }
  if (members.indexOf('app') >= 0) { hub.push(c); return; }   /* UI hub mediated */
  hard.push(c);
});
declared.forEach(function (c) { console.log('  已声明 ' + c.join(' -> ')); });
if (hub.length) {
  console.log('  经 UI 枢纽的环 ' + hub.length + ' 条（当前可接受；拆 app.js 的目标就是消掉它们）:');
  hub.slice(0, 4).forEach(function (c) { console.log('    ' + c.join(' -> ')); });
  if (hub.length > 4) console.log('    …另 ' + (hub.length - 4) + ' 条');
}
hard.forEach(function (c) { console.log('  未声明且不经枢纽 ' + c.join(' -> ')); });
if (!hard.length) console.log('  PASS 没有‘未声明且不经枢纽’的环');
if (hub.length) console.log('  说明: 枢纽环不计入违规，但计入‘待拆’——它是 App 成为全局枢纽的直接证据。');

/* ---------------------------------------------- C: core purity (no DOM/IO) */
console.log('\n=== C. core 层纯度（DOM / 画布 / 网络） ===');
let cViolations = 0;
let cDeclared = 0;
let cViewExempt = 0;
const corePatterns = cfg.coreForbidden.patterns;
const coreExceptions = cfg.coreExceptions || {};
const ownsView = (cfg.ownsView && cfg.ownsView.modules) || [];
moduleNames.forEach(function (m) {
  if (layerOf(m) !== 'core') return;
  if (m === '_note') return;
  const src = stripComments(fs.readFileSync(fileOf(m), 'utf8'));
  const exs = (coreExceptions[m] || []);
  const isView = ownsView.indexOf(m) >= 0;
  const hits = [];
  corePatterns.forEach(function (p) {
    const c = (src.match(new RegExp(p.re, 'g')) || []).length;
    if (!c) return;
    const ex = exs.find(function (e) { return e.re === p.re; });
    if (ex) { cDeclared++; console.log('  已声明 ' + m + ' 使用 ' + p.what + '（' + p.re + '）：' + ex.why); return; }
    /* a module that owns its view section may build DOM itself, but nothing else */
    if (isView && p.view) { cViewExempt++; return; }
    hits.push(p.what + '(' + p.re + ')×' + c);
  });
  if (hits.length) {
    console.log('  ' + m + ' 触达 ' + hits.join('、'));
    cViolations++;
  }
});
if (ownsView.length) {
  console.log('  自带 view 段（豁免 DOM，仍不许向上引用）: ' + ownsView.join(', '));
}
if (!cViolations) console.log('  PASS core 层无未声明触达');

/* ------------------------------------------------- D: three-host contract */
console.log('\n=== D. /_proxy 三端契约 ===');
let dViolations = 0;
cfg.proxyContract.assertions.forEach(function (a) {
  const p = path.join(ROOT, a.host);
  if (!fs.existsSync(p)) {
    console.log('  缺文件 ' + a.host + '（' + a.label + '）');
    dViolations++;
    return;
  }
  const src = fs.readFileSync(p, 'utf8');
  /* `(?i)` prefix = case-insensitive. Worth supporting because the three hosts
     spell the same helper in their own idiom (proxy_target_allowed in Python,
     proxyTargetAllowed in JS/Java) and the case is not part of the contract. */
  const flags = /^\(\?i\)/.test(a.re) ? 'i' : '';
  const pattern = a.re.replace(/^\(\?i\)/, '');
  if (!new RegExp(pattern, flags).test(src)) {
    console.log('  缺失 ' + a.host + ' :: ' + a.label + '  (/' + a.re + '/)');
    dViolations++;
  }
});
if (!dViolations) console.log('  PASS 三端契约标记齐全');

/* ------------------------------------------------- E: version literals */
console.log('\n=== E. 版本字面量漂移 ===');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'version.json'), 'utf8')).version;
let eViolations = 0;
/* The pattern captures the version, so both spellings are covered:
   `RyzaChat/1.2.16` (the three hosts' User-Agent) and `RyzaChat-1.2.16.apk`
   (README / PROJECT.md). Comparing the whole match would only ever recognise
   the slash form — which is how the hyphen form stayed a version behind. */
const litRe = new RegExp(cfg.versionLiterals.pattern, 'g');
const litOne = new RegExp(cfg.versionLiterals.pattern);
cfg.versionLiterals.files.forEach(function (rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return;
  const found = fs.readFileSync(p, 'utf8').match(litRe) || [];
  Array.from(new Set(found)).forEach(function (lit) {
    const m = litOne.exec(lit);
    const num = m && m[1] ? m[1] : lit;
    if (num !== version) {
      console.log('  ' + rel + ' 硬写 ' + lit + '，config/version.json 是 ' + version);
      eViolations++;
    }
  });
});
if (!eViolations) console.log('  PASS 版本字面量一致');

/* --------------------------------------------------- F: MIME parity (3 hosts)
   Routes were already asserted in D; the static MIME tables were not, and their
   divergence is not cosmetic. Measured (VAD spike, 2026-09-18): with `.mjs` and
   `.wasm` missing from the desktop host's table, Chromium refuses to import the
   module and onnxruntime-web hard-fails; with them added the same code runs
   clean. Nothing in the tree would have reported that. */
console.log('\n=== F. 静态 MIME 三端一致 ===');
let fViolations = 0;
const mimeReqs = (cfg.mimeContract && cfg.mimeContract.require) || [];
mimeReqs.forEach(function (r) {
  const p = path.join(ROOT, r.host);
  if (!fs.existsSync(p)) { console.log('  缺文件 ' + r.host + '（' + r.ext + '）'); fViolations++; return; }
  if (!new RegExp(r.re).test(fs.readFileSync(p, 'utf8'))) {
    console.log('  ' + r.host + ' 的 MIME 表缺 ' + r.ext + '  (/' + r.re + '/)');
    fViolations++;
  }
});
if (!fViolations) console.log('  PASS 三端 MIME 表覆盖 ' + Array.from(new Set(mimeReqs.map(function (r) { return r.ext; }))).join('/'));

/* --------------------------------------------------------------- summary */
const total = aViolations + problems.length + hard.length + cViolations + dViolations + eViolations + fViolations;
console.log('\n--- 汇总 ---');
console.log('  越层引用 ' + (aViolations + problems.length) + ' | 未声明的硬环 ' + hard.length +
            ' | core 未声明触达 ' + cViolations + ' | 三端契约 ' + dViolations +
            ' | 版本字面量 ' + eViolations + ' | MIME ' + fViolations);
console.log('  不计入违规: 已声明环 ' + declared.length + ' 条、已声明 core 例外 ' + cDeclared +
            ' 项、自带 view 段豁免 ' + cViewExempt + ' 项、枢纽环 ' + hub.length + ' 条（待拆）');
if (plannedMissing.length) {
  console.log('  已声明但尚未创建（计划中的模块，本次跳过）: ' + plannedMissing.join(', '));
}
console.log('  模式: ' + (STRICT ? '--strict（违规即失败）' : '报告模式（不阻断；重构到位后再接进回归）'));
console.log('  边界声明: config/layers.json');

if (STRICT && total > 0) {
  console.log('\n结果: FAIL (' + total + ' 项违规)');
  process.exit(1);
}
console.log('\n结果: OK（报告模式下有 ' + total + ' 项待处理，这是 P0 的基线，不是新引入的）');
