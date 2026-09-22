/* Transport failures on the LLM path — the "it just spins forever" report (#11).

   Two things were wrong and neither showed up as a test failure anywhere:
     * the two messages a player is most likely to meet on a wrong base URL
       (`请求超时` / `网络请求失败`) were Chinese literals inside api.js, so an
       English or Indonesian player got a Chinese toast;
     * the caller could only pattern-match that prose to guess the cause, and
       neither message matched anything — so the panel line said "can't connect,
       try again later" and the player kept re-sending instead of fixing the
       address.
   The wording is now resolved in the UI language and the kind rides on
   err.code. This suite drives the real XHR callbacks to prove both.
   Run: node scripts/transport_error_regression.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'web');
let failures = 0;
const bad = (msg) => { failures++; console.log('  FAIL ' + msg); };
const ok = (cond, name) => { if (cond) console.log('  PASS ' + name); else bad(name); };
const eq = (got, want, name) => {
  if (got === want) console.log('  PASS ' + name);
  else bad(name + ' (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')');
};
const cjk = /[\u3040-\u30ff\u4e00-\u9fff]/;

/* -------------------------------------------------------------- harness */

function makeEnv() {
  const store = {};
  const inflight = [];                 /* every XHR the module opens */
  class FakeXHR {
    constructor() { this.headers = {}; inflight.push(this); }
    open(m, u) { this.method = m; this.url = u; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send() { this.sent = true; }
    abort() { if (this.onabort) this.onabort(); }
  }
  const sandbox = {
    console, Math, JSON, Date, Object, Array, String, Number, isFinite, parseInt, parseFloat,
    RegExp, Promise, Set, Map, Infinity, NaN, Error, TextDecoder,
    XMLHttpRequest: FakeXHR,
    location: { origin: 'http://127.0.0.1:8765' },
    navigator: {}, fetch: () => Promise.reject(new Error('no fetch in this suite')),
    document: { getElementById: () => null, createElement: () => ({ style: {} }) }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  vm.createContext(sandbox);
  const load = (f) => vm.runInContext(fs.readFileSync(path.join(WEB, 'js', f), 'utf8'),
                                      sandbox, { filename: f });
  for (const f of ['util.js', 'i18n.js', 'config.js', 'api.js']) load(f);
  return { sandbox, inflight, store };
}

/* One real Api.chat call, then the transport callback fires. */
async function chatFailing(env, fire) {
  env.inflight.length = 0;
  const p = env.sandbox.Api.chat([], 'halo', { standalone: true });
  const xhr = env.inflight[env.inflight.length - 1];
  if (!xhr) return { err: new Error('no request was opened') };
  fire(xhr);
  try { await p; return { err: null, xhr }; }
  catch (e) { return { err: e, xhr }; }
}

(async () => {
  console.log('\n# 1. 超时/连不上：错误带 code，文案跟界面语言走');
  {
    const env = makeEnv();
    const { Api, Config, I18n } = env.sandbox;
    Config.set('llm.baseUrl', 'https://api.example.test/v1');
    Config.set('llm.apiKey', 'sk-test-key');
    Config.set('llm.model', 'test-model');
    I18n.setLang('en');

    let r = await chatFailing(env, (x) => x.ontimeout && x.ontimeout());
    ok(!!r.err, 'a timed-out chat rejects');
    eq(r.err && r.err.code, 'timeout', 'the timeout carries err.code');
    eq(r.err && r.err.message, I18n.t('api.timeout'), 'the timeout message is the localized one');
    ok(!cjk.test(r.err.message), 'an English player is not shown Chinese');
    ok(/base url/i.test(r.err.message), 'the timeout message names the setting to check');

    r = await chatFailing(env, (x) => x.onerror && x.onerror());
    eq(r.err && r.err.code, 'net', 'a connection failure carries err.code');
    eq(r.err && r.err.message, I18n.t('api.net'), 'the net message is the localized one');
    ok(!cjk.test(r.err.message), 'an English player is not shown Chinese');
    ok(/base url/i.test(r.err.message), 'the net message names the setting to check');

    /* the report came from an Indonesian UI */
    I18n.setLang('id');
    r = await chatFailing(env, (x) => x.ontimeout && x.ontimeout());
    ok(!cjk.test(r.err.message), 'an Indonesian player is not shown Chinese');
    ok(/base url/i.test(r.err.message), 'and the Indonesian wording names it too');

    /* the request itself is still a normal proxied chat call */
    const good = await (async () => {
      env.inflight.length = 0;
      const p = env.sandbox.Api.chat([], 'halo', { standalone: true });
      const xhr = env.inflight[env.inflight.length - 1];
      xhr.status = 200;
      xhr.responseText = JSON.stringify({ choices: [{ message: { content: 'やあ' } }] });
      xhr.onload();
      return p;
    })();
    ok(good && typeof good.text === 'string', 'a 200 reply still parses into a tagged reply');
  }

  console.log('\n# 2. 每一个传输 code 在七种语言里都有词');
  {
    const env = makeEnv();
    const { I18n } = env.sandbox;
    const src = fs.readFileSync(path.join(WEB, 'js', 'api.js'), 'utf8');
    const codes = [...new Set([...src.matchAll(/transportError\('([a-z_]+)'\)/g)].map((m) => m[1]))];
    ok(codes.length >= 2, 'api.js raises at least the two transport kinds (' + codes.join(', ') + ')');
    const locales = I18n.LANGS.map((l) => l.id);
    const live = I18n.lang;
    for (const lg of locales) {
      I18n.setLang(lg);
      const missing = codes.filter((c) => I18n.t('api.' + c) === 'api.' + c);
      eq(missing.length, 0, lg + ': every transport code has a message' +
         (missing.length ? ' — missing ' + missing.join(', ') : ''));
      const chinese = codes.filter((c) => lg !== 'zh' && lg !== 'zh-tw' && lg !== 'ja' &&
                                            cjk.test(I18n.t('api.' + c)));
      eq(chinese.length, 0, lg + ': no Chinese transport message leaks into this locale');
    }
    I18n.setLang(live);
    /* The old literals must not creep back: this is what the regression is for.
       Comments are stripped first — the fix's own explanation quotes them. */
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    ok(!/请求超时|网络请求失败/.test(bare), 'api.js keeps no hardcoded Chinese transport error');
  }

  console.log(failures ? '\nTRANSPORT: ' + failures + ' FAILURES' : '\nTRANSPORT: ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
