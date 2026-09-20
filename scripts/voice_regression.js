/* Headless regression for the turn layer (turn.js) and the reply epoch in
   api.js. Run:  node scripts/voice_regression.js

Why this exists
---------------
Interruption is the one behaviour that cannot be checked by looking at a
screenshot: it is about what *stops*. Three things must all be true when the
character is cut off — the utterance stops mid-clip, the queued lines are
dropped, and the reply still on the wire never lands. Before turn.js none of
that was expressible, and api.js had no epoch at all, so two replies could
resolve out of order (AUDIT 11.4-3).

The transport is stubbed with a hand-driven XMLHttpRequest, so every ordering
below is deterministic — no timers, no network, no race.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'web', 'js');
let failures = 0;
function ok(cond, name) {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name); }
}

/* --------------------------------------------------------------- sandbox */
const store = {};
const sandbox = {
  console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
  Promise: Promise, JSON: JSON, Math: Math, Date: Date, String: String,
  Number: Number, Object: Object, Array: Array, RegExp: RegExp, Error: Error,
  isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
  URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
  AbortController: AbortController
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.location = { origin: 'http://127.0.0.1:8765', reload() {} };
sandbox.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
  key: (i) => Object.keys(store)[i] || null,
  get length() { return Object.keys(store).length; }
};
sandbox.navigator = { userAgent: 'node' };
const fakeEl = {
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  style: {}, querySelector() { return fakeEl; }, querySelectorAll() { return []; },
  appendChild() {}, setAttribute() {}, addEventListener() {}, removeEventListener() {},
  innerHTML: '', textContent: '', value: ''
};
sandbox.document = {
  getElementById: () => fakeEl, querySelector: () => fakeEl,
  querySelectorAll: () => [], createElement: () => fakeEl,
  addEventListener() {}, body: fakeEl, documentElement: fakeEl
};

/* A hand-driven XHR: the test decides exactly when (and how) it completes. */
const pending = [];
function FakeXHR() {
  this.status = 0; this.responseText = ''; this.timeout = 0;
  this._aborted = false;
  pending.push(this);
}
FakeXHR.prototype.open = function () {};
FakeXHR.prototype.setRequestHeader = function () {};
FakeXHR.prototype.send = function () { this.sent = true; };
FakeXHR.prototype.abort = function () {
  this._aborted = true;
  if (typeof this.onabort === 'function') this.onabort();
};
/* Resolve the oldest outstanding request (sent, not aborted, not yet completed). */
function flush(status, payload) {
  const xhr = pending.find((x) => x.sent && !x._aborted && !x._done);
  if (!xhr) throw new Error('flush(): no in-flight request');
  xhr._done = true;
  xhr.status = status;
  xhr.responseText = JSON.stringify(payload);
  xhr.onload();
  return xhr;
}
function inflight() {
  return pending.filter((x) => x.sent && !x._aborted && !x._done).length;
}
sandbox.XMLHttpRequest = FakeXHR;

vm.createContext(sandbox);
const load = (f) => vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'),
                                   sandbox, { filename: f });
for (const f of ['util.js', 'config.js', 'i18n.js', 'api.js', 'providers.js', 'turn.js', 'echo.js', 'voice.js', 'npc.js']) {
  load(f);
}
const { Turn, Api, Config } = sandbox;

/* ------------------------------------------------------------- harness */
function mkDeferred() {
  let res, rej;
  const p = new Promise((a, b) => { res = a; rej = b; });
  return { promise: p, resolve: res, reject: rej };
}
function recorder() {
  const ev = [];
  Turn.on((e) => ev.push(e));
  return ev;
}
const sleep = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  /* A promise that never settles would let node drain the event loop and exit
     0 with the run half-finished — the worst possible outcome for a gate. */
  const watchdog = setTimeout(() => {
    console.error('\nvoice_regression: TIMED OUT (a promise never settled)' +
                  ' — treated as a failure');
    process.exit(1);
  }, 15000);

  console.log('\n=== A. intent model (turn.js) ===');

  /* ---- A1: a plain utterance runs, and reports thinking → speaking */
  let synths = [], plays = [];
  const mkPlayer = () => (url, signal) => {
    const d = mkDeferred();
    plays.push({ url, signal, end: d.resolve });
    return d.promise;
  };
  Turn.setSynth((text, meta, signal) => {
    synths.push({ text, meta, signal });
    return Promise.resolve('blob:a1');
  });
  Turn.setPlayer(mkPlayer());
  let ev = recorder();

  const a1 = Turn.speak('いち', { mode: 'chat' });
  await sleep();
  ok(Turn.state() === Turn.SPEAKING, 'A1 utterance reaches speaking');
  ok(ev.some((e) => e.type === 'state' && e.state === 'thinking'), 'A1 thinking reported before speaking');
  ok(plays.length === 1 && plays[0].url === 'blob:a1', 'A1 player received the synthesized url');
  ok(Turn.isSpeaking() === true, 'A1 isSpeaking() is the authority the UI reads');

  /* ---- A2: 'queue' waits, does not cut in */
  Turn.speak('に', { behavior: 'queue' });
  await sleep();
  ok(Turn.waiting() === 1, 'A2 queue behaviour waits for the active utterance');
  ok(synths.length === 1, 'A2 queued text is not synthesized yet');

  /* ---- A3: the queue advances through ONE path, natural end included */
  plays[0].end();
  await sleep();
  ok(plays.length === 2 && Turn.waiting() === 0, 'A3 queued utterance starts when the active one ends');
  ok(synths.length === 2, 'A3 the promoted utterance was synthesized');
  plays[1].end();
  await sleep();
  ok(Turn.state() === Turn.IDLE, 'A3 state returns to idle once nothing is left');

  /* ---- A4: interrupt preempts; equal priority is enough */
  plays.length = 0; synths.length = 0;
  Turn.stopAll('reset');
  ev = recorder();
  Turn.speak('ながい', { priority: 1 });
  await sleep();
  plays.length = 0;
  Turn.speak('わりこみ', { behavior: 'interrupt', priority: 1 });
  await sleep();
  ok(ev.some((e) => e.type === 'cancel' && e.reason === 'preempted'), 'A4 equal-priority interrupt preempts');
  ok(Turn.waiting() === 0, 'A4 preempting utterance is not also queued');
  ok(plays.length === 1 && plays[0].url === 'blob:a1', 'A4 replacement playback started');

  /* ---- A5: a lower-priority interrupt must NOT cut in */
  Turn.stopAll('reset');
  plays.length = 0;
  Turn.speak('えらいひと', { priority: 5 });
  await sleep();
  plays.length = 0;
  Turn.speak('したっぱ', { behavior: 'interrupt', priority: 1 });
  await sleep();
  ok(Turn.waiting() === 1, 'A5 lower-priority interrupt queues instead of cutting in');
  ok(plays.length === 0, 'A5 no playback started for the queued intent');

  /* ---- A6: 'replace' cuts in regardless of priority */
  Turn.stopAll('reset');
  plays.length = 0;
  Turn.speak('えらいひと', { priority: 5 });
  await sleep();
  Turn.speak('よびだし', { behavior: 'replace', priority: 0 });
  await sleep();
  ok(Turn.waiting() === 0, 'A6 replace ignores priority');

  /* ---- A7: stopAll drops the queue, interrupt keeps it */
  Turn.stopAll('reset');
  plays.length = 0;
  Turn.speak('いち');
  await sleep();
  Turn.speak('に', { behavior: 'queue' });
  Turn.speak('さん', { behavior: 'queue' });
  ok(Turn.waiting() === 2, 'A7 two queued before the stops');
  Turn.interrupt('one-shot');
  await sleep();
  ok(Turn.waiting() === 1 && Turn.state() === Turn.SPEAKING,
     'A7 interrupt cuts the active one and the queue keeps playing');
  Turn.stopAll('all');
  await sleep();
  ok(Turn.waiting() === 0 && Turn.state() === Turn.IDLE, 'A7 stopAll drops the queue too');

  console.log('\n=== B. reply epoch (api.js) ===');
  Config.set('llm.apiKey', 'k');
  Config.set('llm.baseUrl', 'https://example.invalid/v1');

  /* ---- B1: chat allocates its own epoch when the caller hands in none */
  const e0 = Api.turnEpoch();
  const b1 = Api.chat([], 'ひとつめ', {});
  ok(Api.turnEpoch() === e0 + 1, 'B1 chat allocates its own epoch when none is given');
  ok(inflight() === 1, 'B1 the request is tracked so it can be aborted');

  /* ---- B2: bumping the epoch while the reply is on the wire aborts it */
  let staleB2 = null;
  b1.catch((e) => { staleB2 = e; });
  Api.newTurn('interrupt');
  await sleep();
  ok(staleB2 && staleB2.stale === true, 'B2 an interrupted reply rejects as STALE');
  ok(inflight() === 0, 'B2 nothing is left in flight after the abort');

  /* ---- B3: the ordered-landing guard. This is AUDIT 11.4-3: the reply has
     already resolved, the epoch moves in the same tick, and the caller's
     continuation must not see content. Without the check the older reply
     would land on top of the newer turn. */
  let staleB3 = null;
  const b3 = Api.chat([], 'ふたつめ', {});
  b3.catch((e) => { staleB3 = e; });
  flush(200, { choices: [{ message: { content: 'おそい へんじ' } }] });
  Api.newTurn('newer-turn');
  await sleep();
  ok(staleB3 && staleB3.stale === true, 'B3 a reply that resolved then got superseded is STALE');

  /* ---- B4: an untouched turn still parses normally. The visual tag line is
     the FIRST line of a reply (AUDIT 13), and it must be consumed, not shown. */
  const b4 = Api.chat([], 'みっつめ', {});
  flush(200, { choices: [{ message: { content: '[emotion:happy]\nげんき' } }] });
  const r4 = await b4;
  ok(r4 && r4.text === 'げんき' && r4.emotion === 'happy',
     'B4 an uninterrupted reply parses (tag line consumed, text clean)');

  /* ---- B5: a side call must not supersede the player's own reply. Quest text
     generation and the settings "test LLM" button both go through Api.chat; when
     they allocated an epoch they aborted whatever was in flight, and App.say's
     handler treats STALE as "superseded on purpose" and returns quietly — the
     player's message vanished with no answer, no toast and no retry. */
  const eBeforeSide = Api.turnEpoch();
  let sideStale = null;
  const b5side = Api.chat([], 'そくてい', { standalone: true });
  b5side.catch((e) => { sideStale = e; });
  ok(Api.turnEpoch() === eBeforeSide, 'B5 a stand-alone call does not allocate an epoch');
  flush(200, { choices: [{ message: { content: 'だいじょうぶ' } }] });
  const r5 = await b5side;
  ok(r5 && r5.text === 'だいじょうぶ' && !sideStale,
     'B5 a stand-alone call resolves and is never judged stale');
  /* ...and it is not tracked, so a later turn cannot abort it either. */
  ok(inflight() === 0, 'B5 a stand-alone call leaves nothing tracked in flight');

  console.log('\n=== C. turn begin/end (what App.say does) ===');
  let cancelled = [];
  Turn.setTurnCanceller((reason) => { cancelled.push(reason); return Api.newTurn(reason); });
  Turn.stopAll('reset');
  Turn.speak('とちゅう', {});
  await sleep();
  const eBegin = Turn.beginTurn('say');
  ok(cancelled.indexOf('say') >= 0, 'C1 beginTurn asks the transport to cancel');
  ok(Turn.state() === Turn.THINKING, 'C1 beginTurn puts the turn in thinking');
  ok(eBegin === Api.turnEpoch(), 'C1 the epoch handed to Api.chat is the live one');
  Turn.finishTurn();
  ok(Turn.state() === Turn.IDLE, 'C2 finishTurn is the only way back to idle after a reply');

  /* ---- C3: interrupt is the architecture's single stop exit, so it must also
     invalidate a reply still on the wire — not just silence the audio. It used
     to bump nothing: a caller interrupting during THINKING (the stop button, the
     vad.js onset) left the request running and the reply landed and was spoken
     after the player had asked for silence. */
  const c3 = Api.chat([], 'とちゅうの へんじ', { epoch: Turn.beginTurn('say') });
  let c3stale = null;
  c3.catch((e) => { c3stale = e; });
  const epochBeforeInterrupt = Api.turnEpoch();
  Turn.interrupt('user-barge-in');
  await sleep();
  ok(Api.turnEpoch() > epochBeforeInterrupt, 'C3 interrupt advances the reply epoch');
  ok(c3stale && c3stale.stale === true, 'C3 a reply in flight is discarded by an interrupt');
  ok(inflight() === 0, 'C3 and its request is aborted, not merely ignored');

  /* ---- C4: a cancelled intent must not report a second `end` when its player
     settles after the abort — that duplicate re-armed the mic cooldown twice and
     told listeners a line had finished that was already reported as cancelled. */
  Turn.stopAll('reset');
  const done = mkDeferred();
  Turn.setPlayer(() => done.promise);
  Turn.setSynth(() => Promise.resolve('blob:one'));
  const evC4 = recorder();
  Turn.speak('いちどだけ', {});
  await sleep();
  Turn.interrupt('cut');
  await sleep();
  const c4ends = evC4.filter((e) => e.type === 'end').length;
  done.resolve();                        /* the aborted player settles late */
  await sleep();
  ok(c4ends === 0 && evC4.filter((e) => e.type === 'end').length === 0,
     'C4 a cancelled intent emits cancel only, never a late duplicate end');

  /* ---- C5: without a canceller the turn must hand back null rather than
     inventing an epoch: a made-up 1 is compared against Api's own counter (0)
     and the very first reply would be judged STALE and dropped. */
  Turn.setTurnCanceller(null);
  const eNoCancel = Turn.beginTurn('say');
  ok(eNoCancel === null, 'C5 beginTurn returns null when no canceller is injected');
  Turn.setTurnCanceller((reason) => Api.newTurn(reason));
  Turn.stopAll('reset');

  console.log('\n=== D. failures do not wedge the turn ===');
  Turn.stopAll('reset');
  const ev2 = recorder();
  Turn.setSynth(() => Promise.reject(new Error('NO_KEY')));
  Turn.speak('だめな こ', {});
  await sleep();
  ok(ev2.some((e) => e.type === 'error'), 'D1 a synth failure is reported as an event');
  ok(Turn.state() === Turn.IDLE, 'D2 the turn returns to idle after a failure (no wedge)');
  ok(Turn.waiting() === 0, 'D3 nothing is left waiting after a failure');

  console.log('\n=== E. provider registry (providers.js) ===');
  const Prov = sandbox.Providers;
  Config.set('tts.provider', 'qwen');
  Config.set('tts.qwenApiKey', 'qk');
  Config.set('tts.qwenBaseUrl', 'https://q.example');
  Config.set('tts.apiKey', 'ok');
  Config.set('tts.baseUrl', 'https://o.example');

  const cq = Prov.credentials(Config.section('tts'));
  ok(cq.id === 'qwen' && cq.apiKey === 'qk' && cq.baseUrl === 'https://q.example',
     'E1 the active provider resolves to its OWN fields only');

  Config.set('tts.provider', 'fish');
  const cf = Prov.credentials(Config.section('tts'));
  ok(cf.apiKey === '' && cf.baseUrl === '',
     'E2 switching provider does NOT carry the previous key/baseUrl over (AUDIT 6.9)');

  Config.set('tts.provider', 'voicevox');
  const cv = Prov.credentials(Config.section('tts'));
  ok(cv.capabilities.local === true && cv.apiKey === '',
     'E3 a local engine needs no key');
  ok(cv.baseUrl === 'http://127.0.0.1:50021/' && cv.voice === '0',
     'E3 local engine has a working default URL and style id');

  Config.set('tts.provider', 'openai');
  Config.set('tts.mode', 'clone');
  const cc = Prov.credentials(Config.section('tts'));
  ok(cc.model !== '' && cc.model === Config.section('tts').modelClone,
     'E4 openai in clone mode resolves the clone model, not the preset one');
  Config.set('tts.mode', 'preset');

  Config.set('tts.provider', 'nope');
  ok(Prov.credentials(Config.section('tts')).id === 'openai',
     'E5 an unknown provider id falls back to openai instead of throwing');
  Config.set('tts.provider', 'voicevox');

  /* The local engine protocol is two POSTs to the engine's own origin — one
     implementation shared by VOICEVOX and AivisSpeech (that is what the table
     buys: a compatible engine is a row, not a code path). */
  const calls = [];
  const stubFetch = (url, opts) => {
    calls.push({ url: String(url), opts: opts });
    if (String(url).indexOf('audio_query') >= 0) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ speedScale: 1 }) });
    }
    return Promise.resolve({ ok: true, blob: () => Promise.resolve({ type: 'audio/wav' }) });
  };
  const localUrl = await Prov.speakLocal(Prov.credentials(Config.section('tts')),
                                         { text: 'やあ', fetch: stubFetch });
  ok(calls.length === 2 && calls[0].url.indexOf('audio_query') >= 0 &&
     calls[1].url.indexOf('synthesis') >= 0,
     'E6 local engine: audio_query then synthesis');
  ok(calls[0].opts.method === 'POST' && calls[0].url.indexOf('speaker=0') >= 0,
     'E6 the style id travels as the speaker parameter');
  ok(typeof localUrl === 'string' && localUrl.length > 0,
     'E6 local synthesis returns a blob url like the cloud paths do');

  let localErr = null;
  await Prov.speakLocal(Prov.credentials(Config.section('tts')),
                        { text: 'x', fetch: () => Promise.reject(new Error('failed to fetch')) })
    .catch((e) => { localErr = e; });
  ok(localErr && localErr.hint === 'local-engine' && /连不上本地引擎/.test(localErr.message),
     'E7 an unreachable engine names the likely cause (not running / no cross-origin)');

  console.log('\n=== F. voice input gate (echo.js + voice.js) ===');
  const Echo = sandbox.Echo, Voice = sandbox.Voice;

  /* F1-F4: the text-level echo guard, with an explicit clock. This is what
     catches her own words when the platform's echo canceller cannot. */
  Echo.reset();
  const t0 = 1000000;
  Echo.remember('今日はいい天気だね、一緒に冒険に行こう', t0);
  ok(Echo._lcsRatio('abc', 'abc') === 1, 'F1 the similarity metric is a proper ratio');
  ok(Echo.looksLikeEcho('今日はいい天気だね、一緒に冒険に行こう', t0 + 100) === true,
     'F1 her own line, heard back, is recognised as an echo');
  ok(Echo.looksLikeEcho('まったく別のことを言ってみるよ', t0 + 100) === false,
     'F2 an unrelated line is not treated as an echo');
  ok(Echo.looksLikeEcho('うん', t0 + 100) === false,
     'F3 a short utterance is never matched (too little signal)');
  ok(Echo.looksLikeEcho('今日はいい天気だね、一緒に冒険に行こう',
                        t0 + Echo.LOOKBACK_MS + 1) === false,
     'F4 the lookback window expires');

  /* F5-F9: the microphone gate, with a stubbed recogniser and a manual clock. */
  let lastRec = null;
  function FakeRec() { this.continuous = false; this.interimResults = false; lastRec = this; }
  FakeRec.prototype.start = function () { lastRec = this; this.starts = (this.starts || 0) + 1; };
  FakeRec.prototype.stop = function () { this.stopped = true; if (this.onend) this.onend(); };
  sandbox.SpeechRecognition = FakeRec;

  /* The recogniser reports a final result with the shape the real API uses:
     results[i] is a result, results[i][0] is an alternative with .transcript
     and the result carries .isFinal. */
  function deliver(rec, text) {
    const result = [{ transcript: text }];
    result.isFinal = true;
    rec.onresult({ resultIndex: 0, results: [result] });
  }

  let now = 500000, speakingNow = false;
  const heard = [], notices = [];
  Voice.setClock(() => now);
  Voice.setEcho(Echo);
  Voice.setSpeaker(() => speakingNow);
  Voice.setSink((text) => heard.push(text));
  Voice.setNotice((code) => notices.push(code));
  Voice.setLang(() => sandbox.Langs.sttTag('ja'));
  Voice._reset();
  Echo.reset();

  ok(Voice.available() === true, 'F5 the recogniser is detected');
  ok(Voice.start() === true && Voice.isListening() === true, 'F5 the mic can be turned on');
  const rec = lastRec;
  ok(rec && rec.continuous === true && rec.lang === 'ja-JP',
     'F5 configured continuous, with the BCP-47 tag the language slot resolves to');
  /* Every language the UI can select must resolve to a tag. i18n.js owns that
     mapping now; the copy that used to live in voice.js was missing `hi`, `id`
     and `pt-br`, so three of the seven UI languages listened for Japanese. */
  const langGaps = sandbox.Langs.ALL.map((l) => l.v).filter((v) => v !== 'auto')
    .filter((v) => !sandbox.Langs.STT_TAGS[v]);
  ok(langGaps.length === 0, 'F5 every selectable language has an STT tag' +
     (langGaps.length ? ' (missing: ' + langGaps.join(', ') + ')' : ''));

  /* Her speech in the room beats everything else. */
  speakingNow = true;
  deliver(rec, 'おなじことを繰り返してしまう');
  ok(heard.length === 0, 'F6 nothing is forwarded while she is speaking');
  ok(Voice.suppressedUntil() > now, 'F6 and the cooldown is armed');

  /* ...and it stays armed for the cooldown window. */
  speakingNow = false;
  deliver(rec, 'まだ おなじ ことば');
  ok(heard.length === 0, 'F7 the microphone stays deaf during the cooldown');
  now += Voice.COOLDOWN_MS + 1;
  deliver(rec, 'もう いけるはず');
  ok(heard.length === 1 && heard[0] === 'もう いけるはず',
     'F7 after the cooldown a player line gets through');

  /* The text-level guard catches what an echo canceller cannot.
     Fed through Voice.noteAssistantSpeech — the same call App makes from the
     synthesis port — because the old form of this test called Echo.remember()
     itself and so proved only that echo.js works, never that production ever
     recorded a line. It did not: nothing called remember at all, so the filter
     always answered "no". */
  ok(Voice.noteAssistantSpeech('さっき言ったことばを そのまま 繰り返すよ') === true,
     'F8 her own line is recorded through the module that hears the microphone');
  deliver(rec, 'さっき言ったことばを そのまま 繰り返すよ');
  ok(heard.length === 1, 'F8 a transcript identical to her own recent line is dropped');
  /* ...and the filter is not a blanket suppressor: a genuinely different line
     still gets through. */
  deliver(rec, 'ぜんぜん ちがう ことばだよ');
  ok(heard.length === 2, 'F8 a different line is still forwarded');

  /* A barge-in must not arm the cooldown that would swallow the very utterance
     which caused the interruption. */
  Voice.noteAssistantSpeechEnded('user-barge-in');
  ok(Voice.suppressedUntil() <= now, 'F8 a user barge-in does not deafen the microphone');
  deliver(rec, 'わりこみで いった ことば');
  ok(heard.length === 3, 'F8 the interrupting utterance reaches the app');
  /* Any other stop does arm it (her own tail audio is still in the room). */
  Voice.noteAssistantSpeechEnded('done');
  ok(Voice.suppressedUntil() > now, 'F8 a normal stop still arms the cooldown');
  Voice._reset();

  /* A pending barge countdown must not survive the microphone being switched
     off: it would otherwise cut her off with the mic closed. */
  let bargeFired = 0;
  speakingNow = true;
  Voice.setBargeIn(() => { bargeFired++; });
  Voice.start();
  Voice.noteAssistantSpeechStarted();
  now += Voice.FIRST_SENTENCE_MS + 1;
  lastRec.onspeechstart();
  ok(Voice._bargePending() === true, 'F8 the onset armed the confirmation window');
  Voice.stop();
  ok(Voice._bargePending() === false, 'F8 switching the mic off cancels a pending barge-in');
  await new Promise((r) => setTimeout(r, Voice.BARGE_CONFIRM_MS + 80));
  ok(bargeFired === 0, 'F8 and it never fires afterwards');
  speakingNow = false;
  Voice.setBargeIn(null);
  Voice._reset();

  /* A recogniser that dies instantly, over and over, must give up, not spin. */
  notices.length = 0;
  Voice._reset();
  Voice.start();
  const rec2 = lastRec;
  for (let i = 0; i < Voice.MAX_RAPID_RESTARTS + 2; i++) rec2.onend();
  ok(Voice.isListening() === false,
     'F9 a recogniser that keeps ending at once is not restarted forever');
  ok(notices.indexOf('mic.unstable') >= 0, 'F9 and the player is told why it stopped');

  console.log('\n=== G. onset barge-in (opt-in) ===');
  /* A fresh recogniser stub whose onset/end events the test drives by hand. */
  Voice._reset();
  Echo.reset();
  Voice.setNotice((code) => notices.push(code));
  let bargeCalls = 0;
  const bargeOn = () => { bargeCalls++; };
  Voice.BARGE_CONFIRM_MS = 5;          /* keep the regression quick */
  Voice.FIRST_SENTENCE_MS = 700;
  now = 900000;

  /* G1: disabled means disabled — the onset event must not do anything. */
  Voice.setBargeIn(null);
  Voice.start();
  const rb = lastRec;
  speakingNow = true;
  Voice.noteAssistantSpeechStarted();
  now += 1000;                         /* past the first-sentence window */
  rb.onspeechstart();
  await new Promise((r) => setTimeout(r, 30));
  ok(bargeCalls === 0, 'G1 with barge-in off an onset never interrupts');

  /* G2: armed, but her opening moments are protected. */
  Voice.setBargeIn(bargeOn);
  Voice.noteAssistantSpeechStarted();  /* she just started this line */
  rb.onspeechstart();
  await new Promise((r) => setTimeout(r, 30));
  ok(bargeCalls === 0, 'G2 an onset in her first moments does not cut her off');

  /* G3: a real barge-in fires once the confirmation window passes. */
  now += Voice.FIRST_SENTENCE_MS + 50;
  rb.onspeechstart();
  ok(Voice._bargePending() === true, 'G3 an onset arms a pending barge-in, not an instant cut');
  await new Promise((r) => setTimeout(r, 30));
  ok(bargeCalls === 1, 'G3 the pending barge-in fires after the confirmation window');

  /* G4: speech that stops before confirmation was a cough, not a turn. */
  bargeCalls = 0;
  now += 1000;
  rb.onspeechstart();
  rb.onspeechend();                    /* ends before the timer fires */
  await new Promise((r) => setTimeout(r, 30));
  ok(bargeCalls === 0 && Voice._bargePending() === false,
     'G4 an onset that ends before confirmation is discarded (cough, chair, door)');

  /* G5: nothing to interrupt → nothing happens. */
  bargeCalls = 0;
  speakingNow = false;
  now += 1000;
  rb.onspeechstart();
  await new Promise((r) => setTimeout(r, 30));
  ok(bargeCalls === 0 && Voice._bargePending() === false,
     'G5 an onset while she is silent is ignored');

  console.log('\n=== H. NPC speakers (npc.js) ===');
  const Npc = sandbox.Npc;
  /* npc.js reads World lazily, so a stub installed here is what it sees. */
  sandbox.World = {
    npcs: { npcs: [
      { id: 'npc_ryza', name: 'ライザ', resolveOrder: 1,
        bases: [{ stageId: 'stage_01_002_01', pct: 100 }], move: { area: 0, field: 0, stage: 0 } },
      { id: 'npc_tao', name: 'タオ', note: '錬金術の先生', resolveOrder: 10,
        bases: [{ stageId: 'stage_01_002_01', pct: 80 }], move: { area: 0, field: 0, stage: 0 } },
      { id: 'npc_lent', name: 'レント', resolveOrder: 20,
        bases: [{ stageId: 'stage_01_010_01', pct: 100 }], move: { area: 1, field: 1, stage: 0 } }
    ] },
    npcName: (id) => ({ npc_ryza: 'ライザ', npc_tao: 'タオ', npc_lent: 'レント' }[id] || id),
    find: (sid) => ({
      stage_01_002_01: { stageId: 'stage_01_002_01', areaId: 'area_01', fieldId: 'field_01' },
      stage_01_010_01: { stageId: 'stage_01_010_01', areaId: 'area_01', fieldId: 'field_02' }
    }[sid] || null),
    placement: () => ({ npc_tao: 'stage_01_002_01', npc_lent: 'stage_01_010_01' })
  };

  /* H1: no prefix — one Ryza beat, exactly the old behaviour. This is the
     assertion that keeps the protocol from changing replies that already work. */
  const plain = Npc.split('おはよう、今日もいい天気だね');
  ok(plain.length === 1 && plain[0].speaker === 'ryza' && /おはよう/.test(plain[0].text),
     'H1 a reply with no speaker prefix is a single Ryza beat');

  /* H2: an islander speaks, and is attributed to the right person. */
  const mixed = Npc.split('莱莎：あ、タオ先生！\n角色[tao]：やあ、ちょうどいいところに。\n角色[tao]：調合の話をしよう。\n旁白：タオは道具を取り出した。');
  ok(mixed.length === 4, 'H2 four beats parsed from a four-speaker reply');
  ok(mixed[1].speaker === 'npc' && mixed[1].id === 'npc_tao' && mixed[1].name === 'タオ',
     'H2 the short id resolves to the placement id and the localised name');
  ok(mixed[2].id === 'npc_tao' && /調合/.test(mixed[2].text),
     'H3 a second line from the same speaker stays their own beat');
  ok(mixed[3].speaker === 'narrator' && /道具/.test(mixed[3].text),
     'H3 narration is its own beat');

  /* H4: only her words are spoken. */
  ok(Npc.spokenText(mixed) === 'あ、タオ先生！',
     'H4 only Ryza beats reach the synthesiser (NPC and narration are text only)');

  /* H5: an unknown name keeps its line, but nobody else is blamed for it. */
  const unk = Npc.split('角色[nobody]：はじめまして');
  ok(unk.length === 1 && unk[0].speaker === 'npc' && unk[0].id === '' &&
     unk[0].name === 'nobody' && /はじめまして/.test(unk[0].text),
     'H5 an unknown speaker keeps the line but gets no id (nothing invented, nothing lost)');

  /* H6: an unprefixed line is RYZA's line — the prompt promises exactly that
     ("前置きのない行はライザの台詞として扱われる"), and the prompt requires the
     prefix on every line of a multi-line speech so a paragraph cannot drift
     across speakers. Before this, an unprefixed line continued the previous
     beat: after an islander spoke, her answer was appended to HIS beat, shown
     under his name, and never synthesized (spokenText keeps only `ryza`). */
  const cont = Npc.split('角色[tao]：やあ、ライザ。\nおはよう、タオ先生！');
  const c1 = cont[1] || {};
  ok(cont.length === 2, 'H6 an unprefixed line after another speaker is its own beat');
  ok(cont[0] && cont[0].speaker === 'npc' &&
     c1.speaker === 'ryza' && /おはよう/.test(c1.text || ''),
     'H6 and it is Ryza, not a continuation of the islander');
  ok(Npc.spokenText(cont) === 'おはよう、タオ先生！',
     'H6 and it is therefore spoken (the case that used to be swallowed)');
  /* The prefix must be repeated on every line of a multi-line speech, so a
     continued paragraph stays with its speaker. */
  /* H10: 译文行——只显示，永不进 TTS（与 NPC/旁白同一条规则）。 */
  const withTrans = [
    '莱莎：おはよう！',
    '译文：早上好！',
    '角色[tao]：やあ',
    '旁白：タオが手を振った。'
  ].join(String.fromCharCode(10));
  const tb = Npc.split(withTrans);
  ok(tb.length === 4, 'H10 译文行被识别为一个独立拍');
  ok(tb[1].speaker === 'translation' && /早上好/.test(tb[1].text), 'H10 译文拍内容正确');
  ok(Npc.spokenText(tb) === 'おはよう！', 'H10 译文绝不进 TTS');
  ok(Npc.translationText(tb) === '早上好！', 'H10 译文正文可单独取出');
  ok(Npc.hasLabels(withTrans) === true, 'H10 有标签格式被识别');
  ok(Npc.hasLabels('おはよう') === false, 'H10 无标签回复按旧行为');

  /* H10b: 其他 UI 语言的译文标签也认（模型可能用英/日文写标签）。 */
  const enTrans = 'Ryza: Hello!' + String.fromCharCode(10) + 'Translation: Hello!';
  ok(Npc.translationText(Npc.split(enTrans)) === 'Hello!', 'H10b 英文标签可解析');
  const jaTrans = 'ライザ：おはよう' + String.fromCharCode(10) + '訳文：おはよう';
  ok(Npc.translationText(Npc.split(jaTrans)) === 'おはよう', 'H10b 日文标签可解析');

  /* H10c: 机器提示（方括号）既不显示也不朗读。 */
  ok(Npc.stripCues('やあ[happy] 元気？') === 'やあ 元気？', 'H10c 方括号提示被剥掉');
  ok(Npc.stripCues('[face:shy]ねえ[action:wave]') === 'ねえ', 'H10c 多个提示被剥掉');

  /* H10d: 只有旁白、没有她的台词时，朗读文本必须为空。 */
  const onlyNarr = Npc.split('旁白：彼女は窓のそばに立っている。');
  ok(Npc.spokenText(onlyNarr) === '', 'H10d 只有旁白时朗读为空（不念旁白）');

  const multi = Npc.split('角色[tao]：一行目\n角色[tao]：二行目\n莱莎：わかった');
  const m0 = multi[0] || {}, m1 = multi[1] || {}, m2 = multi[2] || {};
  ok(multi.length === 3 && m0.speaker === 'npc' && m1.speaker === 'npc' &&
     m2.speaker === 'ryza',
     'H6 repeating the prefix keeps a multi-line speech with its speaker');
  ok(/付け直す/.test(Npc.promptBlock({ stage: 'stage_01_002_01', day: 1 })),
     'H6 the prompt states that rule, so prompt and parser agree');

  /* H7: candidates come from the world data, are ranked by closeness, and Ryza
     is never one of them. Being in the same AREA is enough to be a candidate —
     the ranking is what decides who is worth mentioning. */
  const cand = Npc.candidates('stage_01_002_01', 1, 6);
  ok(cand.length === 2 && cand[0].id === 'npc_tao',
     'H7 the islander scheduled into this very stage ranks first');
  ok(cand[1] && cand[1].id === 'npc_lent' && cand[1].score < cand[0].score,
     'H7 an islander with a base in the same area is a lower-ranked candidate');
  ok(cand.filter((c) => c.id === 'npc_ryza').length === 0,
     'H7 Ryza is never a candidate to speak as an NPC');
  ok(Npc.candidates('stage_99_999_99', 1).length === 0,
     'H7 an unknown stage yields no candidates');
  ok(Npc._scoreOf(sandbox.World.npcs.npcs[1],
                  { stageId: 'stage_01_002_01', areaId: 'area_01', fieldId: 'field_01' }, 1) === 8000,
     'H7 an in-stage base scores pct x 100 (the exact-stage multiplier)');

  /* H8: the prompt block carries the roster, the limits and the frequency. */
  const blk = Npc.promptBlock({ stage: 'stage_01_002_01', day: 1 },
                              { appCfg: { npcFrequency: 'frequent' } });
  ok(/npc_tao/.test(blk), 'H8 the block names the candidates by their placement id');
  ok(/角色\[ID\]：/.test(blk), 'H8 and states the protocol line the model must use');
  ok(/2〜3ターン/.test(blk), 'H8 the chosen frequency reaches the prompt');
  ok(/創作しない/.test(blk), 'H8 and it forbids inventing a setting it was not given');
  ok(Npc.frequency({ npcFrequency: 'nonsense' }) === Npc.FREQ.normal,
     'H9 an unknown frequency falls back to normal');

  console.log('\n--- 汇总 ---');
  clearTimeout(watchdog);
  console.log(failures ? '结果: FAIL (' + failures + ' 项)' : '结果: OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('voice_regression crashed: ' + (e && e.stack || e));
  process.exit(1);
});
