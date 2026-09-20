/* Nsfw clothing state + atlas-variant path convention. No WebGL.
   Run: node scripts/nsfw_intent_regression.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'web');
let failures = 0;
const bad = (msg) => { failures++; console.log('  FAIL ' + msg); };
const ok = (cond, name) => { if (cond) console.log('  PASS ' + name); else bad(name); };

const sandbox = {
  console, Math, JSON, String, Array, RegExp, Object, Date, Number, isFinite,
  parseInt, parseFloat, Infinity, NaN, Set, Map, Promise
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.Avatar = { _calls: [], setAtlasVariant(name) { this._calls.push(name); } };
const configApp = { nsfwEnabled: false };
sandbox.Config = {
  section(name) { return name === 'app' ? configApp : {}; },
  set(path, value) { if (path === 'app.nsfwEnabled') configApp.nsfwEnabled = value; },
  get() { return { app: configApp }; }
};
sandbox.document = { getElementById() { return null; } };
sandbox.XMLHttpRequest = function () {};
sandbox.location = { origin: 'http://127.0.0.1:8765' };
vm.createContext(sandbox);

function load(f) {
  vm.runInContext(fs.readFileSync(path.join(WEB, 'js', f), 'utf8'), sandbox, { filename: f });
}
load('util.js');   // core: owns the emotion/attitude vocabulary api.js validates tags against
load('nsfw.js');
load('api.js');

const N = sandbox.Nsfw;
ok(!!N && N.VARIANT === 'nsfw', 'Nsfw exported');
ok(typeof N.detect !== 'function', 'no keyword detector');
ok(typeof N.decide !== 'function', 'no keyword decide');
ok(typeof N.promptSection !== 'function', 'policy is not duplicated in nsfw.js');

/* One owner for the emotion vocabulary: api.js (io) and avatar.js (render)
   cannot import each other, so core (util.js) holds it. Identity, not just
   equality — a re-declared list with the same contents is the bug. */
ok(sandbox.Api.EMOTIONS === sandbox.Util.EMOTIONS,
   'api.js validates against core\'s emotion list (no second literal)');
ok(sandbox.Api.ATTITUDES === sandbox.Util.ATTITUDES,
   'api.js validates against core\'s attitude list');

/* The renderer is a port now (nsfw/core must not reference avatar/render).
   Wiring it here is the same call app.js makes; before the port, nsfw.js read
   `global.Avatar` itself — an edge the boundary guard could not see. */
N.setSink(function (name) { sandbox.Avatar.setAtlasVariant(name); });
let sinkCalls = 0;
const realSink = sandbox.Avatar.setAtlasVariant.bind(sandbox.Avatar);
sandbox.Avatar.setAtlasVariant = function (name) { sinkCalls++; return realSink(name); };

N.reset();
ok(/着ている/.test(N.screenFact()), 'screenFact: dressed');
N.onTurn({ nsfw: null });
ok(N.active() === false, 'omitted tag does not strip');
N.onTurn({ nsfw: true });
ok(N.active() === false && sandbox.Avatar._calls.pop() === 'default', 'disabled blocks tag nsfw:on');
N.setEnabled(true);
ok(N.enabled() === true && N.active() === true, 'settings toggle enables nsfw');
ok(/肌が見えている/.test(N.screenFact()), 'screenFact: undressed');
N.onTurn({ nsfw: null });
ok(N.active() === true, 'omitted tag keeps undressed');
N.onTurn({ nsfw: false });
ok(N.active() === false && sandbox.Avatar._calls.pop() === 'default', 'tag nsfw:off');
N.onTurn({ nsfw: true });
ok(N.active() === true, 'enabled llm can initiate');
N.setEnabled(false);
ok(N.enabled() === false && N.active() === false, 'settings toggle disables and dresses');
N.onTurn({ nsfw: true });
ok(N.active() === false, 'disabled blocks llm re-enable');
N.setEnabled(true);
N.reset();
ok(N.active() === false && sandbox.Avatar._calls.pop() === 'default', 'reset → default');
ok(sinkCalls >= 3, 'the injected sink is what performs the atlas switch');

/* The port is the only path to the renderer: nsfw.js must not name Avatar at
   all. This is the assertion that would have caught the original leak (a
   core->render edge written as `global.Avatar`, which the layering guard could
   not see because the reference has no trailing dot). */
const nsfwSrc = fs.readFileSync(path.join(WEB, 'js', 'nsfw.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ');
ok(!/\bAvatar\b/.test(nsfwSrc), 'nsfw.js never names the renderer');

const A = sandbox.Api;
if (A && A.parseTaggedReply) {
  const on = A.parseTaggedReply('[emotion:shy|attitude:agree|undress:on]\nやっ');
  ok(on.nsfw === true && on.emotion === 'shy', 'tag undress:on + extra pipe');
  const alias = A.parseTaggedReply('[emotion:shy|nsfw:on]\nやっ');
  ok(alias.nsfw === true, 'nsfw:on still accepted as undress alias');
  const off = A.parseTaggedReply('[emotion:happy|attitude:agree|undress:off]\nhi');
  ok(off.nsfw === false, 'tag undress:off');
  const omit = A.parseTaggedReply('[emotion:happy|attitude:agree]\nhi');
  ok(omit.nsfw == null, 'tag omitted → null');
  const spaced = A.parseTaggedReply('[emotion: shy | attitude: agree | undress: on]\nやっ');
  ok(spaced.nsfw === true && spaced.emotion === 'shy', 'spaces after colons still parse');
  const two = A.parseTaggedReply('[emotion:shy|attitude:agree]\n[undress:on]\nやっ');
  ok(two.nsfw === true && two.emotion === 'shy', 'undress on its own machine line');
  const think = A.parseTaggedReply('<think>keep clothes</think>\n[emotion:shy|undress:on]\nやっ');
  ok(think.nsfw === true && think.text === 'やっ', 'think block before tag still parses');
  const bare = A.parseTaggedReply('セリフだけ');
  ok(bare.emotion == null && bare.attitude == null && bare.nsfw == null,
     'no tag line → omit all (keep last on screen)');
  const sys = A.buildSystemPrompt('chat', 'voice', '', 'ja', N.screenFact());
  const tag = (sys.match(/^\[emotion:.+\]$/m) || [''])[0];
  ok(tag === '[emotion:happy|attitude:agree|undress:off|stage:stage_01_001_04]',
     'prefix is filled from the current screen (dressed, home)');
  ok(/断るなら/.test(sys) && /on=脱いだ/.test(sys) && /undress:/.test(sys),
     'refuse = leave undress, undress = on');
  ok(!/すぐ脱がなくて/.test(sys), 'old delay-undress phrasing is gone');
  ok(tag.indexOf('tod:') === -1, 'real mode tag line has no tod slot');
  ok(!/<state>/.test(sys), 'no RPG context → no <state> example');
  N.onTurn({ nsfw: true });
  const sysOn = A.buildSystemPrompt('chat', 'voice', '', 'ja', N.screenFact());
  ok(/\|undress:on\|/.test(sysOn) && /肌が見えている/.test(sysOn),
     'undressed screen fills undress:on in the prefix');
  N.reset();
  const keepN = A.parseTaggedReply('[emotion:shy|undress:keep|stage:keep]\nhi');
  ok(keepN.nsfw == null && !keepN.state, 'undress:keep / stage:keep still mean omit');
  const echoOff = A.parseTaggedReply('[emotion:happy|undress:off|stage:stage_01_001_04]\nhi');
  ok(echoOff.nsfw === false, 'copied undress:off parses as dressed');
  const go = A.parseTaggedReply('[emotion:happy|stage:stage_01_002_01]\n行こっ');
  ok(go.state && go.state.current_stage === 'stage_01_002_01', 'stage tag → current_stage');
  const slp = A.parseTaggedReply('[emotion:cuddle|stage:sleep]\nおやすみ');
  ok(slp.state && slp.state.sleep === true, 'stage:sleep → sleep');
  const bag = A.parseTaggedReply(
    '[emotion:happy|undress:on|stage:keep]\nやった\n' +
    '<state>{"inventory_added":[{"id":"emeralia","count":1}]}</state>');
  ok(bag.nsfw === true && bag.state && bag.state.inventory_added &&
     bag.state.inventory_added[0].id === 'emeralia' && !bag.state.current_stage,
     'screen fields on the tag; bags in <state>');
  const hist = A.formatHistoryReply('やっ');
  ok(hist.indexOf('[emotion:happy|attitude:agree|undress:off|stage:') === 0 &&
     /\nやっ$/.test(hist),
     'history stores the full screen line + spoken text');
  ok(!/<state>/.test(hist), 'history does not echo RPG deltas');
  const cued = A.withTurnCue('脱いで');
  ok(/^脱いで\n/.test(cued) && /undress:off/.test(cued) && /セリフ/.test(cued),
     'live user turn keeps player text and appends the copy cue');
} else {
  bad('Api.parseTaggedReply missing');
}

/* Same convention for any future skin id — no hardcoded 0001_99. */
function variantPageUrls(atlasUrl, pageName, variant, override) {
  variant = String(variant || '').toLowerCase();
  if (!variant || variant === 'default') return [];
  const dir = String(atlasUrl || '').replace(/[^/]+$/, '');
  const page = String(pageName || '');
  const dot = page.lastIndexOf('.');
  const base = dot >= 0 ? page.slice(0, dot) : page;
  const ext = dot >= 0 ? page.slice(dot) : '.png';
  const out = [];
  const seen = {};
  function add(u) { if (u && !seen[u]) { seen[u] = 1; out.push(u); } }
  if (typeof override === 'string') add(override);
  add(dir + base + variant + ext);
  add(dir + base + '_' + variant + ext);
  return out;
}
const u99 = variantPageUrls(
  'assets/spine/crf_chr_002/crf_skn_002_0001_99/crf_skn_002_0001_99.atlas',
  'crf_skn_002_0001_99.png', 'nsfw');
ok(u99[0] === 'assets/spine/crf_chr_002/crf_skn_002_0001_99/crf_skn_002_0001_99nsfw.png',
   'standing nsfw convention (user file name)');
ok(variantPageUrls(
  'assets/spine/crf_chr_002/crf_skn_002_0002_99/crf_skn_002_0002_99.atlas',
  'crf_skn_002_0002_99.png', 'nsfw')[0].indexOf('crf_skn_002_0002_99nsfw.png') >= 0,
   'future outfit 0002 uses the same convention');
ok(variantPageUrls(
  'assets/spine/crf_chr_002/crf_skn_002_0001_01/crf_skn_002_0001_01.atlas',
  'crf_skn_002_0001_01.png', 'nsfw')[0].indexOf('crf_skn_002_0001_01nsfw.png') >= 0,
   'sitting nsfw is a sibling file, not a special case');
ok(variantPageUrls('x/a.atlas', 'a.png', 'nsfw', 'assets/custom/foo.png')[0] ===
   'assets/custom/foo.png', 'skins.json variants override wins');

const shipped = path.join(WEB, 'assets', 'spine', 'crf_chr_002',
                          'crf_skn_002_0001_99', 'crf_skn_002_0001_99nsfw.png');
ok(fs.existsSync(shipped), 'runtime nsfw page is next to the standing atlas');

/* --- proxy routing (desktop shell regression: ryza://app must NOT bypass) ---
   1.2.9 moved the desktop page from http://127.0.0.1:<port> to ryza://app.
   localProxy keyed off the loopback origin only, so every LLM/TTS call
   skipped /_proxy and died on CORS. All hosts that ship a /_proxy must
   route; a foreign origin must go direct. */
const PROXY_TARGET = 'https://example.test/v1/chat/completions';
function routedFrom(origin) {
  sandbox.location = { origin };
  const u = sandbox.Api._localProxy(PROXY_TARGET);
  return u === '/_proxy?u=' + encodeURIComponent(PROXY_TARGET);
}
ok(routedFrom('http://127.0.0.1:8765'), 'serve.py loopback routes through /_proxy');
ok(routedFrom('http://localhost:8765'), 'localhost routes through /_proxy');
ok(routedFrom('http://192.168.1.120:8765'), 'LAN IP 192.168.x.x routes through /_proxy');
ok(routedFrom('http://10.0.0.5:8765'), 'LAN IP 10.x.x.x routes through /_proxy');
ok(routedFrom('http://172.20.10.2:8765'), 'LAN IP 172.16-31.x.x routes through /_proxy');
ok(routedFrom('http://ryza-server.local:8765'), 'mDNS .local hostname routes through /_proxy');
ok(routedFrom('ryza://app'), 'desktop ryza://app routes through /_proxy (1.2.9 fix)');
sandbox.location = { origin: 'https://elsewhere.test' };
ok(sandbox.Api._localProxy(PROXY_TARGET) === PROXY_TARGET, 'foreign browser origin calls the endpoint direct');
sandbox.location = { origin: 'http://127.0.0.1:8765' };

/* --- Qwen TTS: same protocol, different hosts; model ids change --- */
const HOST = 'https://dashscope.aliyuncs.com';
ok(A._qwenApiRoot('') === HOST, 'empty base → public DashScope');
ok(A._qwenApiRoot('https://dashscope.aliyuncs.com/') === HOST, 'trailing slash stripped');
ok(A._qwenApiRoot('https://dashscope.aliyuncs.com/api/v1') === HOST, 'strip /api/v1');
ok(A._qwenApiRoot('https://dashscope.aliyuncs.com/compatible-mode/v1') === HOST,
   'strip compatible-mode/v1');
ok(A._qwenApiRoot('https://abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1') ===
   'https://abc.cn-beijing.maas.aliyuncs.com', 'workspace host kept');
ok(A._qwenApiRoot('https://proxy.example.com/dashscope') === 'https://proxy.example.com/dashscope',
   'custom prefix kept');
ok(A._qwenApiRoot('https://proxy.example.com/dashscope/api/v1') ===
   'https://proxy.example.com/dashscope', 'custom prefix + /api/v1');
ok(A._qwenApiRoot('https://gateway.example.com/v1') === 'https://gateway.example.com',
   'OpenAI-style /v1 stripped');
ok(A._qwenTtsUrl('', 'qwen3-tts-flash') ===
   HOST + '/api/v1/services/aigc/multimodal-generation/generation',
   'qwen3 → multimodal-generation');
ok(A._qwenTtsUrl('', 'qwen-audio-3.0-tts-flash') ===
   HOST + '/api/v1/services/audio/tts/SpeechSynthesizer',
   'qwen-audio → SpeechSynthesizer');
ok(A._qwenTtsUrl('', 'cosyvoice-v3.5-flash') ===
   HOST + '/api/v1/services/audio/tts/SpeechSynthesizer',
   'cosyvoice → SpeechSynthesizer');
ok(A._qwenTtsUrl(
     HOST + '/api/v1/services/aigc/multimodal-generation/generation',
     'qwen-audio-3.0-tts-plus') ===
   HOST + '/api/v1/services/audio/tts/SpeechSynthesizer',
   'pasted full path rewritten for model family');
ok(A._qwenHttpsUrl('http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/x.wav') ===
   'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/x.wav',
   'http OSS rewritten to https');
ok(A._qwenHttpsUrl('https://already.example/x') === 'https://already.example/x',
   'https OSS left alone');
ok(A._qwenDefaultVoice('qwen-audio-3.0-tts-flash', 'Cherry') === 'longanhuan_v3.6',
   'Cherry remapped on qwen-audio');
ok(A._qwenDefaultVoice('qwen3-tts-flash', 'Serena') === 'Serena',
   'custom qwen3 voice kept');
ok(A._qwenTtsKind('voice-enrollment') === 'enroll', 'enrollment path');
ok(A.QWEN_TTS_MODELS.indexOf('qwen-audio-3.0-tts-flash') >= 0, 'seed includes qwen-audio');
ok(A._localProxy(A._qwenHttpsUrl('http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav'))
     .indexOf('https%3A') >= 0,
   'proxied OSS download is https');

/* --- OpenRouter Speech API: host normalize + TTS URL --- */
const OR_BASE = 'https://openrouter.ai/api/v1';
ok(A._openrouterApiRoot('') === OR_BASE, 'empty base → official OpenRouter api v1');
ok(A._openrouterApiRoot('https://openrouter.ai/') === OR_BASE, 'openrouter site root → /api/v1');
ok(A._openrouterApiRoot('https://openrouter.ai/api/v1') === OR_BASE, 'existing /api/v1 kept');
ok(A._openrouterApiRoot('https://custom-gateway.test/v1') === 'https://custom-gateway.test/v1', 'custom gateway kept');
ok(A._openrouterTtsUrl('') === OR_BASE + '/audio/speech', 'OpenRouter TTS endpoint is /audio/speech');
ok(A.OPENROUTER_TTS_MODELS.indexOf('fish-audio/s2.1-pro-free:free') >= 0, 'seed includes fish-audio s2.1');
ok(A._localProxy(A._openrouterTtsUrl('')).indexOf('/_proxy?u=') === 0, 'OpenRouter TTS routes through /_proxy');

/* --- Fish Audio Open API: host normalize + local-sample clone --- */
const FISH = 'https://fishaudio.org/api/open/v1';
ok(!A.FISH_DEFAULT_VOICE, 'no shipped Fish voice id (clone from local samples)');
ok(A._fishSampleUrls().indexOf('assets/audio/prologue/jp/prologue_08.m4a') >= 0,
   'clone candidates include JP prologue m4a');
ok(A._fishSampleUrls().indexOf('assets/voice/ryza_wav/prologue_08.wav') >= 0,
   'clone candidates include converted wav');
ok(A.FISH_TTS_MODELS.indexOf('fishaudio-s21pro-flash') >= 0, 'seed includes s21pro-flash');
ok(A._fishApiRoot('') === FISH, 'empty Fish base → official Open API v1');
ok(A._fishApiRoot('https://fishaudio.org/') === FISH, 'site root → /api/open/v1');
ok(A._fishApiRoot('https://fishaudio.org/api/open/v1/') === FISH, 'trailing slash stripped');
ok(A._fishApiRoot('https://fishaudio.org/api/open/v1/speech/tts') === FISH,
   'pasted TTS path stripped to root');
ok(A._fishApiRoot('https://fishaudio.org/v1') === FISH, 'compat /v1 → Open API v1');
ok(A._fishApiRoot('https://fishaudio.org/api/open/v3') ===
   'https://fishaudio.org/api/open/v3', 'explicit v3 root kept');
ok(A._fishTtsUrl('') === FISH + '/speech/tts', 'legacy TTS path is /speech/tts');

/* --- the two Fish surfaces (issues #6 / #7) --------------------------------
   Pasting the documented https://api.fish.audio used to be silently rewritten
   to the older host, so the key went somewhere it does not work and the user
   got a confusing failure. The base now picks the surface and stays put. */
const FISH_MODERN = A.FISH_MODERN_BASE;
ok(A._fishApiRoot('https://api.fish.audio') === FISH_MODERN,
   'api.fish.audio is kept, not remapped to the old host');
ok(A._fishApiRoot('https://api.fish.audio/v1') === FISH_MODERN,
   'api.fish.audio/v1 → modern root');
ok(A._fishApiRoot('https://api.fish.audio/v1/tts') === FISH_MODERN,
   'pasted modern TTS path stripped to root');
ok(A._fishApiStyle(FISH_MODERN) === 'modern' && A._fishApiStyle(FISH) === 'legacy',
   'style follows from the resolved root');
ok(A._fishTtsUrl(FISH_MODERN) === FISH_MODERN + '/v1/tts',
   'modern TTS path is /v1/tts');
ok(A._fishTtsUrl('') === FISH + '/speech/tts', 'default base stays on the old surface');
ok(A._localProxy(A._fishTtsUrl(FISH_MODERN)).indexOf('/_proxy?u=') === 0 &&
   A._localProxy(A._fishTtsUrl(FISH_MODERN)).indexOf('api.fish.audio') > 0,
   'modern TTS still goes through /_proxy, to the host the user typed');
ok(/401/.test(A._fishErrorMessage(401, '', 'k')) &&
   /key/i.test(A._fishErrorMessage(401, '', 'k')),
   '401 is reported as a key problem, not a generic failure');
ok(!/SECRET-KEY/.test(A._fishErrorMessage(400, '{"message":"bad SECRET-KEY"}', 'SECRET-KEY')),
   'the key is redacted out of an echoed error body');
ok(/403/.test(A._fishErrorMessage(403, '', 'k')) &&
   /权限|permission/i.test(A._fishErrorMessage(403, '', 'k')),
   '403 names permission/model access and carries the status');

ok(A._fishLanguage('ja') === 'ja' && A._fishLanguage('zh-tw') === 'zh-TW',
   'Fish language codes');
ok(A._localProxy(A._fishTtsUrl('')).indexOf('/_proxy?u=') === 0,
   'Fish TTS goes through /_proxy on loopback');

console.log(failures ? '\nNSFW INTENT: ' + failures + ' FAILURES' : '\nNSFW INTENT: ALL PASS');
process.exit(failures ? 1 : 0);
