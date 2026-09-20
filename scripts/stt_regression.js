/* Headless regression for the speech-input layer: the capture engine
   (web/js/stt.js), the multipart request api.js builds for it, and the engine
   choice/fallback in voice.js. Run:  node scripts/stt_regression.js

   Why this exists
   ---------------
   Speech input only ever worked in a desktop browser: the browser recogniser is
   absent in Electron's renderer and its backend is missing there (`error:
   network` after a successful start(), measured), and the Android WebView had no
   microphone permission at all. The replacement is our own capture plus a
   provider transcription endpoint — a much longer path, and every link of it is
   invisible in a screenshot. So each link is pinned here:

     * the gate is a pure state machine fed one level at a time, so a whole
       conversation can be driven with no microphone and no timing luck;
     * the utterance blob is a real WAV whose header and length are checked;
     * the multipart body api.js sends is inspected field by field (a wrong
       Content-Type here would drop the boundary and every endpoint would reject
       the body);
     * the engine choice is asserted, including the Electron case where a
       recogniser that answers `network` must hand the microphone over to the
       capture engine instead of leaving the feature dead.

   Stubs are deliberately dumb: a test that cannot fail is worse than no test,
   so each assertion below was checked against the old behaviour (negative
   control) before being kept.
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
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, JSON, Math, Date, String, Number, Object, Array, RegExp, Error,
  isNaN, parseInt, parseFloat, Blob, AbortController,
  URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.location = { origin: 'http://127.0.0.1:8765' };
sandbox.navigator = { userAgent: 'node', mediaDevices: { getUserMedia: null } };
sandbox.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
  key: (i) => Object.keys(store)[i] || null,
  get length() { return Object.keys(store).length; }
};
sandbox.document = {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} })
};

/* A recording XHR: nothing is sent anywhere, and the test decides the reply. */
let lastXhr = null;
function FakeXHR() { this.headers = {}; lastXhr = this; }
FakeXHR.prototype.open = function (m, u) { this.method = m; this.url = u; };
FakeXHR.prototype.setRequestHeader = function (k, v) { this.headers[k.toLowerCase()] = v; };
FakeXHR.prototype.send = function (b) { this.body = b; };
FakeXHR.prototype.abort = function () { if (this.onabort) this.onabort(); };
sandbox.XMLHttpRequest = FakeXHR;

vm.createContext(sandbox);
const load = (f) => vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'),
                                   sandbox, { filename: f });
for (const f of ['util.js', 'config.js', 'i18n.js', 'providers.js', 'api.js',
                 'echo.js', 'stt.js', 'voice.js']) {
  load(f);
}
const { Stt, Voice, Api, Config, Providers, Langs } = sandbox;

(async () => {
  const watchdog = setTimeout(() => {
    console.error('\nstt_regression: TIMED OUT (a promise never settled) — treated as a failure');
    process.exit(1);
  }, 15000);

  /* =================================================================== A */
  console.log('\n=== A. the gate (pure state machine) ===');
  let now = 100000;
  const heard = [], notices = [];
  const said = [];
  let transcribeCalls = 0, transcribeReply = null;
  Stt.setClock(() => now);
  Stt.setSink((t) => heard.push(t));
  Stt.setNotice((c, e) => notices.push(c));
  Stt.setLang(() => 'ja');
  Stt.setTranscriber((blob) => {
    transcribeCalls++;
    said.push(blob);
    return Promise.resolve(typeof transcribeReply === 'function' ? transcribeReply(blob) : transcribeReply);
  });
  let onsets = 0;
  Stt.setOnset(() => { onsets++; });
  Stt._reset();

  const LOUD = 0.6, QUIET = 0.01;
  const frame = (v) => {
    const f = new Float32Array(800); // 50 ms at 16 kHz
    for (let i = 0; i < f.length; i++) f[i] = Math.sin(i * 0.3) * v;
    return f;
  };
  /* Feed `ms` of one level in 50 ms steps, advancing the clock. */
  const feed = (level, ms) => {
    for (let t = 0; t < ms; t += 50) {
      Stt._pushFrame(frame(level), false);
      Stt._feedLevel(level, now);
      now += 50;
    }
  };

  /* A1: a click is not an utterance. */
  feed(QUIET, 300);                 // settle the baseline
  feed(LOUD, 100);                  // a door, a cough
  feed(QUIET, 600);
  ok(onsets === 0 && transcribeCalls === 0 && Stt._state().speaking === false,
     'A1 a 100 ms blip never becomes an utterance (onset needs ' + Stt.MIN_SPEECH_MS + ' ms)');

  /* A2: real speech does, and the onset fires once, at confirmation. */
  feed(LOUD, 400);
  ok(onsets === 1, 'A2 the onset fires once, after the confirmation window');
  ok(Stt._state().speaking === true, 'A2 the utterance is open');
  feed(LOUD, 1000);
  ok(onsets === 1, 'A2 a continuing utterance does not re-fire the onset');

  /* A3: the end of speech is decided by candidate silence, and it is sent. */
  transcribeReply = 'こんにちは、ライザです';
  feed(QUIET, 200);
  ok(transcribeCalls === 0, 'A3 a short pause inside a sentence does not cut it');
  feed(QUIET, Stt.CANDIDATE_SILENCE_MS + 100);
  await new Promise((r) => setTimeout(r, 0));
  ok(transcribeCalls === 1, 'A3 candidate silence closes the utterance and sends it once');
  ok(heard.length === 1 && heard[0] === 'こんにちは、ライザです',
     'A3 the transcript reaches the sink');
  ok(Stt._state().speaking === false, 'A3 the utterance is closed');

  /* A4: the blob is a real WAV, not a raw dump. */
  const wav = said[0];
  const bytes = new Uint8Array(await wav.arrayBuffer());
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const view = new DataView(bytes.buffer);
  ok(tag === 'RIFF' && String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === 'WAVE',
     'A4 the utterance is a WAV container (RIFF/WAVE)');
  ok(view.getUint16(22, true) === 1 && view.getUint32(24, true) === 16000,
     'A4 mono, 16 kHz — the rate an ASR endpoint and a VAD frame both want');
  ok(view.getUint32(40, true) === bytes.length - 44,
     'A4 the data chunk length matches the payload');
  ok(wav.type === 'audio/wav' && bytes.length > 44, 'A4 and it is not empty');

  /* A5: the pre-roll is kept, so the first syllable is not clipped, but a
     previous utterance's audio is not carried over. */
  const oneUtterance = bytes.length;
  ok(oneUtterance < 16000 * 2 * 4,
     'A5 the blob holds the utterance, not the whole session (' + oneUtterance + ' bytes)');

  /* A6: an empty transcript is reported and not forwarded. */
  feed(QUIET, 200);
  transcribeReply = '   ';
  notices.length = 0;
  feed(LOUD, 400);
  feed(QUIET, Stt.CANDIDATE_SILENCE_MS + 100);
  await new Promise((r) => setTimeout(r, 0));
  ok(heard.length === 1 && notices.indexOf('mic.empty') >= 0,
     'A6 an empty transcript is not forwarded as an empty player turn');

  /* A7: a failing endpoint reports, and does not wedge the module. */
  transcribeReply = () => { throw new Error('NO_STT_URL'); };
  notices.length = 0;
  feed(QUIET, 200);
  feed(LOUD, 400);
  feed(QUIET, Stt.CANDIDATE_SILENCE_MS + 100);
  await new Promise((r) => setTimeout(r, 0));
  ok(notices.some((c) => c.indexOf('mic.error:') === 0),
     'A7 a transcription failure is reported as a mic notice');
  transcribeReply = 'つぎは いくよ';
  notices.length = 0;
  feed(QUIET, 200);
  feed(LOUD, 400);
  feed(QUIET, Stt.CANDIDATE_SILENCE_MS + 100);
  await new Promise((r) => setTimeout(r, 0));
  ok(heard.length === 2 && heard[1] === 'つぎは いくよ',
     'A7 and the next utterance still goes through (no wedge)');

  /* A8: no transcriber injected → say so instead of silently dropping audio. */
  Stt.setTranscriber(null);
  notices.length = 0;
  feed(QUIET, 200);
  feed(LOUD, 400);
  feed(QUIET, Stt.CANDIDATE_SILENCE_MS + 100);
  await new Promise((r) => setTimeout(r, 0));
  ok(notices.indexOf('mic.noTranscriber') >= 0,
     'A8 without a transcriber the player is told, not left with silence');

  /* =================================================================== B */
  console.log('\n=== B. capture lifecycle (stubbed host APIs) ===');
  let stops = 0, addModule = 0;
  sandbox.navigator.mediaDevices.getUserMedia = () => {
    ok(arguments && true, 'B1 getUserMedia called');
    return Promise.resolve({
      getTracks: () => [{ stop() { stops++; } }]
    });
  };
  function FakeAC() {
    this.sampleRate = 16000;
    this.state = 'running';
    this.audioWorklet = { addModule: () => { addModule++; return Promise.resolve(); } };
    this.createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
    this.createGain = () => ({ gain: {}, connect() {}, disconnect() {} });
    this.close = () => {};
    this.destination = {};
  }
  sandbox.AudioContext = FakeAC;
  sandbox.AudioWorkletNode = function () {
    this.port = { onmessage: null, postMessage() {} };
    this.connect = () => {};
    this.disconnect = () => {};
  };
  /* The echo constraints the docs claimed but the code never requested: assert
     the request carries them, since without a stream of our own there is
     nothing for the browser to apply them to. */
  let gumOpts = null;
  sandbox.navigator.mediaDevices.getUserMedia = (o) => {
    gumOpts = o;
    return Promise.resolve({ getTracks: () => [{ stop() { stops++; } }] });
  };

  Stt._reset();
  Stt.setTranscriber(() => Promise.resolve('x'));
  ok(Stt.available() === true, 'B1 the capture engine reports availability from getUserMedia');
  await Stt.start();
  ok(gumOpts && gumOpts.audio && gumOpts.audio.echoCancellation === true &&
     gumOpts.audio.noiseSuppression === true && gumOpts.audio.autoGainControl === true,
     'B1 the mic is opened WITH the echo/noise/AGC constraints');
  ok(addModule === 1, 'B1 the worklet module is loaded once');
  ok(Stt.isListening() === true, 'B1 the session is open');
  Stt.stop();
  ok(stops === 1 && Stt.isListening() === false,
     'B1 stopping releases the track (otherwise the browser keeps showing "listening")');
  Stt._reset();

  /* =================================================================== C */
  console.log('\n=== C. the multipart request api.js builds ===');
  Config.set('stt.provider', 'whisper');
  Config.set('stt.baseUrl', 'https://stt.example/v1');
  Config.set('stt.apiKey', 'sk-test');
  Config.set('stt.model', 'whisper-large-v3');

  const cred = Providers.sttCredentials(Config.section('stt'));
  ok(cred.id === 'whisper' && cred.model === 'whisper-large-v3',
     'C1 the stt provider row resolves its own fields');
  Config.set('stt.baseUrl', '');
  ok(Providers.sttCredentials(Config.section('stt')).baseUrl === '',
     'C1 clearing the endpoint does not resurrect a default from elsewhere');
  Config.set('stt.baseUrl', 'https://stt.example/v1');

  const audio = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' });
  const p = Api.transcribe(audio, { lang: 'pt-br' });
  const xhr = lastXhr;
  ok(xhr.method === 'POST', 'C2 the transcript request is a POST');
  ok(xhr.url.indexOf('/_proxy?u=') === 0, 'C2 it goes through the local proxy (never straight out)');
  ok(decodeURIComponent(xhr.url.split('u=')[1]) === 'https://stt.example/v1/audio/transcriptions',
     'C2 to the provider row endpoint + /audio/transcriptions');
  ok(xhr.headers['authorization'] === 'Bearer sk-test' && xhr.headers['api-key'] === 'sk-test',
     'C2 with the stt key, not the llm/tts one');
  ok(xhr.headers['content-type'] === undefined,
     'C2 Content-Type is left to the Blob (setting it by hand would drop the boundary)');
  const bodyType = String(xhr.body.type || '');
  const boundary = (bodyType.match(/boundary=(.+)$/) || [])[1];
  ok(/^multipart\/form-data; boundary=/.test(bodyType) && boundary,
     'C2 the body is multipart/form-data carrying a boundary');
  const text = await xhr.body.text();
  ok(text.indexOf('name="model"') >= 0 && text.indexOf('whisper-large-v3') >= 0,
     'C2 the model field is present');
  ok(text.indexOf('name="language"') >= 0 && /language"\r\n\r\npt\r\n/.test(text),
     'C2 the language is ISO-639-1 (pt-br -> pt), not the recogniser BCP-47 tag');
  ok(text.indexOf('filename="speech.wav"') >= 0 && text.indexOf('Content-Type: audio/wav') >= 0,
     'C2 the file part is declared as a wav');
  ok(text.indexOf('--' + boundary + '--') >= 0, 'C2 and the body is terminated');

  xhr.status = 200;
  xhr.responseText = JSON.stringify({ text: '  bom dia  ' });
  lastXhr.onload();
  ok((await p) === 'bom dia', 'C2 the reply text is returned trimmed');

  /* C3: the language mapping has exactly one owner. */
  const gaps = Langs.ALL.map((l) => l.v).filter((v) => v !== 'auto')
    .filter((v) => !Langs.STT_ISO[v]);
  ok(gaps.length === 0, 'C3 every selectable language has an ISO code for the request' +
     (gaps.length ? ' (missing: ' + gaps.join(', ') + ')' : ''));

  /* =================================================================== D */
  console.log('\n=== D. engine choice and the fallback that makes the exe work ===');
  const withCapture = (pref, ready, hasRec) => {
    Stt._reset();
    Voice.setCapture(Stt);
    Voice.setEngine(() => pref);
    Voice.setTranscriberReady(() => ready);
    if (hasRec) sandbox.SpeechRecognition = function () { this.start = () => {}; };
    else delete sandbox.SpeechRecognition;
    return Voice.engine();
  };

  ok(withCapture('capture', true, true) === 'capture',
     'D1 an explicit choice wins even when a recogniser exists');
  ok(withCapture('capture', false, true) === null,
     'D1 capture without a configured endpoint is not offered (no silent dead end)');
  ok(withCapture('webSpeech', true, false) === null,
     'D1 forcing the recogniser in a host without one reports unavailable');
  ok(withCapture('auto', true, true) === 'webSpeech',
     'D1 auto prefers the recogniser when it exists (streaming, zero-config)');
  ok(withCapture('auto', true, false) === 'capture',
     'D1 auto falls back to capture when there is no recogniser (the APK case)');
  ok(withCapture('auto', false, false) === null,
     'D1 with neither engine the feature reports unavailable (the button hides)');

  /* D2: the Electron case. The recogniser EXISTS, so auto picks it; it starts,
     and then its backend answers `network`. The next engine() call must be the
     capture engine, which is the entire reason the microphone works in the exe
     instead of showing five error toasts and switching itself off. */
  ok(withCapture('auto', true, true) === 'webSpeech', 'D2 the recogniser is tried first');
  let switchedNotice = 0;
  Voice.setNotice((c) => { if (c === 'mic.switched') switchedNotice++; });
  const rec = {};
  rec.continuous = false; rec.interimResults = false;
  rec.start = () => {}; rec.stop = () => {};
  sandbox.SpeechRecognition = function () { return rec; };
  Voice._reset();
  ok(Voice.start() === true, 'D2 the session opens on the recogniser');
  rec.onerror({ error: 'network' });          // what Electron actually reports
  await new Promise((r) => setTimeout(r, 0));
  ok(Voice.engine() === 'capture',
     'D2 a recogniser whose backend is missing is struck off for the session');
  ok(switchedNotice === 1, 'D2 the player is told the input switched, once');

  /* D3: a permission refusal must not leave the button looking like it listens. */
  let stateEmits = 0;
  const off = Voice.onState(() => { stateEmits++; });
  rec.onerror({ error: 'not-allowed' });
  ok(Voice.isListening() === false && stateEmits > 0,
     'D3 a denied microphone updates the UI state (isListening false + an emit)');
  off();

  /* =================================================================== E */
  console.log('\n=== E. the gate is shared (capture goes through Voice\'s rules) ===');
  let gated = 0;
  Voice.setEcho(sandbox.Echo);
  Voice.setSink(() => { gated++; });
  Voice.setSpeaker(() => true);              // she is speaking
  sandbox.Echo.reset();
  ok(Voice._accept('これは テストです') === false && gated === 0,
     'E1 a transcript arriving while she speaks is dropped by the shared gate');
  Voice.setSpeaker(() => false);
  Voice._reset();
  ok(Voice._accept('これは テストです') === true && gated === 1,
     'E1 and one arriving while she is quiet goes through');
  const HER_LINE = 'さっき言ったことばを そのまま 繰り返すよ';
  const SHORT_LINE = 'うん、そうだね';
  ok(Voice.noteAssistantSpeech(HER_LINE) === true, 'E1 her own line is recorded');
  /* Past the 800 ms cooldown but INSIDE echo.js's 20 s lookback — going further
     would test the lookback window instead of the echo filter. */
  const t0 = Date.now();
  Voice.setClock(() => t0 + 6000);
  ok(Voice._accept(HER_LINE) === false && gated === 1,
     'E1 the same words echoed back are filtered as echo');
  ok(Voice._accept('ぜんぜん ちがう ことば だよ これ') === true && gated === 2,
     'E1 and the filter is not a blanket suppressor: different words still get through');
  /* The boundary, pinned rather than discovered later: echo.js only compares
     once the recent text reaches MIN_WINDOW_CHARS normalised characters
     (N.E.K.O.'s sliding-window size), so a SHORT line of hers is not filtered.
     That is the documented parameter, and the capture engine now opens the mic
     with echoCancellation as the first layer. */
  ok(sandbox.Echo._normalize(SHORT_LINE).length < 10, 'E1 the short line really is under the window');
  Voice.noteAssistantSpeech(SHORT_LINE);
  ok(Voice._accept(SHORT_LINE) === true && gated === 3,
     'E1 a SHORT echo is not filtered (below the 10-char window — known limit)');

  console.log('\n--- 汇总 ---');
  clearTimeout(watchdog);
  console.log(failures ? '结果: FAIL (' + failures + ' 项)' : '结果: OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('stt_regression crashed: ' + (e && e.stack || e));
  process.exit(1);
});
