/* Voice input: microphone → speech-to-text → gated transcript.

   Why this exists
   ---------------
   The client was half-duplex in the wrong direction: she could talk, the player
   could only type. Everything needed for the other direction already exists now
   — Turn knows whether she is speaking (so the microphone can stand down while
   she does), and echo.js can tell her own words coming back through the mic.
   This module is the missing half: capture, transcribe, and refuse to forward
   anything that is not the player.

   Two things it deliberately does NOT do:
     * It does not decide what a transcript means. It hands accepted text to an
       injected sink; App decides whether to fill the input box or send it.
     * It does not own a VAD. The browser recogniser segments on its own; a
       Silero-based endpoint (and true onset barge-in) is a separate step that
       needs an onnxruntime-web spike on all three hosts first — see
       docs/HANDOFF. Reporting "done" for that here would be a guess.

   Ports are injected (sink / speaker / notice / lang), so the module has no DOM
   and no knowledge of Config; scripts/voice_regression.js drives it with a
   stubbed recogniser, clock and speaker.
*/
(function (global) {
  'use strict';

  /* The recogniser wants a BCP-47 tag. That mapping lives in i18n.js
     (Langs.sttTag) because it is language metadata and this module already
     receives the language through a port — a second copy here is how `hi`,
     `id` and `pt-br` (three of the seven UI languages) ended up with no tag at
     all, silently falling back to ja-JP. The lang port returns a ready tag. */
  var DEFAULT_TAG = 'ja-JP';

  /* After she stops talking the microphone stays muted for a moment: the tail
     of her audio is still in the room (and in the recogniser's buffer) and would
     otherwise come back as a player turn. Same value airi uses. */
  var COOLDOWN_MS = 800;
  /* A recogniser that ends immediately, over and over, is broken (no mic, no
     permission, engine gone) — stop restarting instead of spinning. */
  var MAX_RAPID_RESTARTS = 5;

  var _sink = null, _speaker = null, _notice = null, _lang = null, _echo = null;
  var _barge = null;        /* fn() — performs the interruption; null = disabled */
  /* Two engines behind one gate (this module owns the gate, so both must go
     through it — echo suppression and the half-duplex rule are engine-agnostic):
       'webSpeech' — the browser's own recogniser, streaming, zero-config
       'capture'   — web/js/stt.js: our own PCM capture + provider transcription
     The recogniser is absent in Electron and unusable in the APK (measured), so
     'capture' is what makes the microphone work where the app actually ships. */
  var _capture = null;
  var _enginePref = null;   /* fn() -> 'auto' | 'webSpeech' | 'capture' */
  var _transcriberReady = null;  /* fn() -> is a transcription endpoint configured */
  var _webSpeechDead = false;    /* the recogniser answered, and refused */

  var _want = false;        /* the player asked for the mic to be on */
  var _rec = null;
  var _suppressedUntil = 0;
  var _restarts = 0;
  var _startedAt = 0;
  var _speakStartedAt = 0;
  var _bargeTimer = null;
  var _now = function () { return Date.now(); };

  function emit(text) { if (_sink) { try { _sink(text); } catch (e) {} } }
  function notice(msg, isErr) { if (_notice) { try { _notice(msg, !!isErr); } catch (e) {} } }
  function speaking() {
    if (!_speaker) return false;
    try { return !!_speaker(); } catch (e) { return false; }
  }

  function Ctor() {
    return global.SpeechRecognition || global.webkitSpeechRecognition || null;
  }

  function armCooldown() { _suppressedUntil = _now() + COOLDOWN_MS; }

  /* Decided once per transcript, in this order: her speech in the room beats
     everything, then the cooldown, then the text-level echo check. */
  function accept(text) {
    var t = String(text == null ? '' : text).trim();
    if (!t) return false;
    if (speaking()) { armCooldown(); return false; }
    if (_now() < _suppressedUntil) return false;
    if (_echo && _echo.looksLikeEcho && _echo.looksLikeEcho(t, _now())) return false;
    emit(t);
    return true;
  }

  function build() {
    var R = Ctor();
    if (!R) return null;
    var rec = new R();
    rec.continuous = true;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    try {
      rec.lang = (_lang && _lang()) || DEFAULT_TAG;
    } catch (e) { /* some engines reject an unknown tag; the default is fine */ }

    rec.onresult = function (ev) {
      var res = ev && ev.results;
      if (!res) return;
      for (var i = (ev.resultIndex || 0); i < res.length; i++) {
        var r = res[i];
        if (!r || !r.isFinal) continue;
        accept(r[0] && (r[0].transcript != null ? r[0].transcript : r[0]));
      }
    };
    rec.onerror = function (ev) {
      var code = (ev && ev.error) || '';
      if (code === 'no-speech' || code === 'aborted') return;   /* normal */
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        Voice._want = _want = false;
        notice('mic.denied', true);
        /* Emit, or the button keeps its "listening" look while isListening() is
           already false. The mic.unstable path below always did this. */
        Voice._emitState();
        return;
      }
      /* The recogniser exists but its backend does not. Measured in the packaged
         Electron shell: start() succeeds, `onstart` fires, then `network` — so
         the constructor being present proves nothing, and this is the only way
         to find out. Strike it off for the session and move to the capture
         engine, which is what makes the microphone usable in the exe at all. */
      if (code === 'network' || code === 'language-not-supported') {
        _webSpeechDead = true;
        try { if (_rec) _rec.stop(); } catch (e) {}
        if (Voice.engine() === 'capture') {
          notice('mic.switched', false);
          var wasWant = _want;
          _want = false;
          if (wasWant) Voice.start();
          return;
        }
      }
      notice('mic.error:' + code, true);
    };
    /* Onset barge-in. The recogniser's own speech-start event is a real onset
       signal, so this needs no VAD model — but it cannot tell her voice from
       the player's, which is why it is opt-in (see the note at the bottom of
       this file). Two guards keep it from firing on noise or on her own
       opening syllable. */
    rec.onspeechstart = function () { Voice._onSpeechStart(); };
    rec.onspeechend = function () { Voice._cancelBarge(); };
    rec.onend = function () {
      if (!_want) { Voice._emitState(); return; }
      /* Web Speech ends on its own after silence; keep listening unless that
         keeps happening instantly, which means it is not actually working. */
      var ranFor = _now() - _startedAt;
      if (ranFor < 400) _restarts++; else _restarts = 0;
      if (_restarts > MAX_RAPID_RESTARTS) {
        _want = false;
        notice('mic.unstable', true);
        Voice._emitState();
        return;
      }
      try { rec.start(); _startedAt = _now(); } catch (e) { _want = false; Voice._emitState(); }
    };
    return rec;
  }

  var Voice = {
    COOLDOWN_MS: COOLDOWN_MS,
    MAX_RAPID_RESTARTS: MAX_RAPID_RESTARTS,
    /* Speech onset is not speech: a cough, a chair, a door all fire it. Wait
       this long and require her to still be talking before cutting in
       (N.E.K.O.'s confirm_speech_ms). */
    BARGE_CONFIRM_MS: 240,
    /* Her first moments are protected: the start of her own sentence is the
       loudest thing in the room, and on a setup without echo cancellation it
       is the most likely thing to be mistaken for the player. */
    FIRST_SENTENCE_MS: 700,

    /* ------------------------------------------------------------- ports */
    setSink: function (fn) { _sink = (typeof fn === 'function') ? fn : null; },
    setSpeaker: function (fn) { _speaker = (typeof fn === 'function') ? fn : null; },
    setNotice: function (fn) { _notice = (typeof fn === 'function') ? fn : null; },
    setLang: function (fn) { _lang = (typeof fn === 'function') ? fn : null; },
    setEcho: function (mod) { _echo = mod || null; },
    setClock: function (fn) { _now = (typeof fn === 'function') ? fn : _now; },
    /* Injecting the interrupt keeps this module ignorant of turns: App wires it
       to Turn.interrupt. Passing null disables barge-in entirely. */
    setBargeIn: function (fn) { _barge = (typeof fn === 'function') ? fn : null; },
    /* The capture engine (web/js/stt.js). Injecting it also connects it to THIS
       module's gate, so both engines are filtered by the same echo/half-duplex
       rules instead of each growing its own. */
    setCapture: function (mod) {
      _capture = mod || null;
      if (_capture && _capture.setSink) _capture.setSink(accept);
      if (_capture && _capture.setOnset) _capture.setOnset(function () { Voice._onSpeechStart(); });
    },
    setEngine: function (fn) { _enginePref = (typeof fn === 'function') ? fn : null; },
    /* fn() -> whether a transcription endpoint is configured. Without one the
       capture engine has nothing to send the audio to, so it must not be chosen
       (the player then gets "configure it in settings" instead of silence). */
    setTranscriberReady: function (fn) { _transcriberReady = (typeof fn === 'function') ? fn : null; },

    /* Which engine will actually be used, in preference order:
         webSpeech  — streaming and zero-config, so it wins when it exists
         capture    — our own audio → provider transcription
       A recogniser that answered and refused (Electron: `network`) is struck off
       for the session, which is the difference between "feature is dead" and
       "feature switched itself to the path that works". */
    engine: function () {
      var pref = (_enginePref && _enginePref()) || 'auto';
      var hasRec = !!Ctor() && !_webSpeechDead;
      var hasCap = !!(_capture && _capture.available && _capture.available()) &&
                   (!_transcriberReady || !!_transcriberReady());
      if (pref === 'webSpeech') return hasRec ? 'webSpeech' : null;
      if (pref === 'capture') return hasCap ? 'capture' : null;
      if (hasRec) return 'webSpeech';
      return hasCap ? 'capture' : null;
    },

    /* ------------------------------------------------------------- state */
    available: function () { return !!Voice.engine(); },
    isListening: function () { return !!_want; },
    suppressedUntil: function () { return _suppressedUntil; },

    start: function () {
      var eng = Voice.engine();
      if (!eng) { notice('mic.unsupported', true); return false; }
      if (_want) return true;
      _want = true;
      _restarts = 0;
      if (eng === 'capture') {
        /* stt.js reports its own failures through its notice port; the promise
           is only used to keep _want honest. */
        _capture.start().then(function (okFlag) {
          if (!okFlag && _want) { _want = false; Voice._emitState(); }
        });
        Voice._emitState();
        return true;
      }
      try {
        _rec = _rec || build();
        _rec.start();
        _startedAt = _now();
      } catch (e) {
        _want = false;
        notice('mic.error:' + (e && e.message || e), true);
      }
      Voice._emitState();
      return _want;
    },

    stop: function () {
      _want = false;
      Voice._cancelBarge();
      try { if (_rec) _rec.stop(); } catch (e) { /* already stopped */ }
      try { if (_capture) _capture.stop(); } catch (e) { /* already stopped */ }
      Voice._emitState();
      return true;
    },

    toggle: function () { return Voice.isListening() ? Voice.stop() : Voice.start(); },

    /* She just said this: remember it as her own words so the recogniser
       hearing them back is not mistaken for the player. This is the only feed
       into echo.js from production code, and it is what makes the text-level
       echo filter (echo.js: 20 s lookback, >= 0.88 similarity) actually do
       something — the module was wired into the mic but nothing ever recorded
       a line, so `looksLikeEcho` could only ever answer "no". */
    noteAssistantSpeech: function (text) {
      var t = String(text == null ? '' : text);
      if (!t.trim()) return false;
      if (!_echo || typeof _echo.remember !== 'function') return false;
      try { _echo.remember(t, _now()); } catch (e) { return false; }
      return true;
    },

    /* She finished a line: keep the microphone deaf for a moment. App calls
       this from its Turn subscription — the turn layer must not know about
       microphones, and this module must not know about turns.

       The reason matters for one case: if she stopped *because the player
       started talking* (`user-barge-in`), a cooldown would swallow the very
       utterance that caused the interruption, so the words never reach the
       model. Any other stop is her own tail audio and does need the guard. */
    noteAssistantSpeechEnded: function (reason) {
      Voice._cancelBarge();
      if (_want && reason !== 'user-barge-in') armCooldown();
      Voice._emitState();
    },

    /* Her line started — needed to protect her opening moments (see
       FIRST_SENTENCE_MS). */
    noteAssistantSpeechStarted: function () { _speakStartedAt = _now(); },
    selfSpeechFor: function () { return _speakStartedAt ? (_now() - _speakStartedAt) : 0; },

    /* Block input for a while (UI asking, or a manual mute window). */
    suppressFor: function (ms) {
      var until = _now() + Math.max(0, Number(ms) || 0);
      if (until > _suppressedUntil) _suppressedUntil = until;
    },

    /* ---------------------------------------------------------- internals
       Exposed for the regression: the gate decision has to be testable without
       a real microphone, and a recogniser stub has no business re-implementing
       it. */
    _accept: accept,

    /* Onset seen. Only cut in when there is something to cut into, her opening
       moments are over, and the onset survives the confirmation window. */
    _onSpeechStart: function () {
      if (!_barge) return;
      if (!speaking()) return;
      if (Voice.selfSpeechFor() < Voice.FIRST_SENTENCE_MS) return;
      if (_bargeTimer) return;
      _bargeTimer = setTimeout(function () {
        _bargeTimer = null;
        if (!speaking()) return;          /* she finished first — nothing to do */
        try { _barge(); } catch (e) { /* an interrupt must never break the mic */ }
      }, Voice.BARGE_CONFIRM_MS);
    },
    _cancelBarge: function () {
      if (!_bargeTimer) return;
      clearTimeout(_bargeTimer);
      _bargeTimer = null;
    },
    _bargePending: function () { return !!_bargeTimer; },
    _stateListeners: [],
    _emitState: function () {
      Voice._stateListeners.slice().forEach(function (f) {
        try { f(Voice.isListening()); } catch (e) {}
      });
    },
    onState: function (fn) {
      if (typeof fn !== 'function') return function () {};
      Voice._stateListeners.push(fn);
      return function () {
        var i = Voice._stateListeners.indexOf(fn);
        if (i >= 0) Voice._stateListeners.splice(i, 1);
      };
    },
    _reset: function () {
      Voice._cancelBarge();
      _rec = null; _want = false; _suppressedUntil = 0; _restarts = 0;
    }
  };

  global.Voice = Voice;
})(typeof window !== 'undefined' ? window : globalThis);

/* Why onset barge-in is opt-in (app.bargeIn, default off)
   ------------------------------------------------------
   The recogniser's speech-start event cannot tell the player from her. On a
   setup where the microphone hears the loudspeaker, her own voice fires the
   onset and she cuts herself off mid-sentence — the failure mode is worse than
   not having the feature, and it is invisible in a screenshot.

   Two things make it safe enough to offer: browser echo cancellation (on by
   default in getUserMedia) and the guards above. Neither is a guarantee. The
   complete fix is a playback-level comparison — only treat an onset as the
   player when the room is louder than the current playback leakage — which
   needs the level port that avatar._voiceDb already computes, and a real VAD
   (Silero via onnxruntime-web) for hosts whose recogniser has no onset event
   at all. Both are listed as follow-ups rather than half-done here.
*/
