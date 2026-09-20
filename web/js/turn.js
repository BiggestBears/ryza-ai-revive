/* Turn authority: who is speaking, what is queued, and what an interruption
   cancels. One module owns that question so nothing else has to guess.

   Why it exists
   -------------
   Speech used to be fire-and-forget: speakThen got a blob URL and handed it to
   App.playUrl, which set <audio>.src and returned. There was no way to stop an
   utterance half-way, and nothing that could say "she is talking right now" —
   so lip sync, the bubble lifetime and the ASMR playback rate each tracked it
   separately (AUDIT 8 documents the rate-reset bug that produced). Interruption
   needs all of that to end together.

   Semantics (intent model)
   ------------------------
   * Every utterance is an intent with `priority` (number) and `behavior`:
       'queue'     — wait for the current utterance to finish
       'interrupt' — cut in, but only if priority >= the active intent's
       'replace'   — always cut in (used by UI previews / alarms)
   * One intent is active at a time; the rest wait in order.
   * cancelIntent(id) / interrupt() / stopAll() are the three stops, matching
     @proj-airi/pipelines-audio's vocabulary.

   Semantics (cancellation)
   ------------------------
   An interruption cancels the pending reply, not just the audio: the epoch is
   bumped (api.js aborts the in-flight XHR) and a reply that resolves after the
   bump is STALE and never reaches the caller. `beginTurn` and `interrupt` are
   both that exit. NOTE: the epoch covers the chat request only — an in-flight
   *TTS* request is not aborted (Api.speak takes no signal), so an interrupt
   during synthesis still pays for that request; the blob is discarded when it
   arrives. Threading the signal into Api.speak/translate is a known follow-up,
   not something this comment should claim.

   Ports are injected, so this module knows nothing about transport or
   rendering — same convention as avatar.setNotice / memory.setLLM /
   quests.setPresenter. Everything defaults to inert, which is what lets
   scripts/voice_regression.js drive it headlessly and deterministically.
*/
(function (global) {
  'use strict';

  var IDLE = 'idle', THINKING = 'thinking', SPEAKING = 'speaking';

  var _synth = null;      /* fn(text, meta, signal) -> Promise<url|null> */
  var _player = null;     /* fn(url, signal, meta) -> Promise           */
  var _cancelTurn = null; /* fn(reason) -> epoch                       */
  var _subs = [];

  var _state = IDLE;
  var _epoch = null;
  var _active = null;     /* { id, priority, ownerId, controller, signal, meta } */
  var _waiting = [];
  var _seq = 0;
  /* Cancelled intent ids, so the abort settlement that follows a cancel does
     not emit a second `end` for an utterance already reported as cancelled
     (that duplicate re-armed the microphone cooldown twice). */
  var _cancelled = {};

  function emit(ev) {
    _subs.slice().forEach(function (f) {
      try { f(ev); } catch (e) { /* a listener must never break the turn */ }
    });
  }

  function setState(s) {
    if (_state === s) return;
    _state = s;
    emit({ type: 'state', state: s });
  }

  /* AbortController is not guaranteed in every host the regressions stub, so
     fall back to a signal-shaped object that only ever reports "not aborted".
     Interruption still works there because stopAll() drops the intent. */
  function makeSignal() {
    if (typeof global.AbortController === 'function') {
      var c = new global.AbortController();
      return { controller: c, signal: c.signal };
    }
    var sig = {
      aborted: false,
      _ls: [],
      addEventListener: function (t, f) { if (t === 'abort') sig._ls.push(f); },
      removeEventListener: function (t, f) {
        var i = sig._ls.indexOf(f);
        if (i >= 0) sig._ls.splice(i, 1);
      }
    };
    return {
      controller: null,
      signal: sig,
      abort: function () { sig.aborted = true; sig._ls.slice().forEach(function (f) { try { f(); } catch (e) {} }); }
    };
  }

  function cancelActive(reason) {
    if (!_active) return false;
    var a = _active;
    _active = null;
    _cancelled[a.id] = true;
    try {
      if (a.controller) a.controller.abort(reason);
      else if (a.abortFallback) a.abortFallback();
    } catch (e) { /* already gone */ }
    emit({ type: 'cancel', reason: reason || 'cancel', intentId: a.id });
    return true;
  }

  /* The queue advances through exactly one path, so "the active intent ended"
     and "the active intent was cancelled" cannot diverge — A7 in
     scripts/voice_regression.js is the assertion that caught them diverging.
     Re-entrancy: `finish` emits `end` before promoting, and a listener is
     allowed to start something new from that event (proactive.js will). If it
     did, the new intent is already playing and must not be replaced by a
     queued one. */
  function promote() {
    if (_active) return false;
    var next = _waiting.shift();
    if (next) { run(next); return true; }
    setState(IDLE);
    return false;
  }

  function finish(id, reason) {
    /* Already reported as cancelled: the player settling after the abort is
       not a second end. */
    if (_cancelled[id]) { delete _cancelled[id]; return; }
    if (_active && _active.id !== id) return;   /* superseded already */
    _active = null;
    emit({ type: 'end', reason: reason, intentId: id });
    promote();
  }

  function revoke(url) {
    try {
      if (url && global.URL && URL.revokeObjectURL) URL.revokeObjectURL(url);
    } catch (e) { /* nothing to revoke */ }
  }

  function run(intent) {
    var made = makeSignal();
    _active = {
      id: intent.id, priority: intent.priority, ownerId: intent.ownerId,
      controller: made.controller, signal: made.signal,
      abortFallback: made.abort, meta: intent.meta
    };
    setState(THINKING);
    emit({ type: 'start', intentId: intent.id, intent: intent });

    var out;
    try {
      out = _synth ? _synth(intent.text, intent.meta, made.signal) : Promise.resolve(null);
    } catch (e) {
      out = Promise.reject(e);
    }

    Promise.resolve(out).then(function (url) {
      /* The intent died while synthesis was in flight: throw the blob away
         instead of playing it (this is the "she stops mid-sentence" path). */
      if (made.signal.aborted) { revoke(url); return; }
      if (!url || !_player) { finish(intent.id, url ? 'no-player' : 'no-audio'); return; }
      setState(SPEAKING);
      emit({ type: 'speak', intentId: intent.id, url: url, intent: intent });
      return Promise.resolve(_player(url, made.signal, intent.meta))
        .then(function () { finish(intent.id, made.signal.aborted ? 'interrupted' : 'done'); });
    }).catch(function (e) {
      if (made.signal.aborted) { finish(intent.id, 'interrupted'); return; }
      finish(intent.id, 'error');
      emit({ type: 'error', error: e, intent: intent });
    });
  }

  /* Start of a user turn: whatever she was saying (and everything queued
     behind it) is superseded, and the caller gets the epoch to hand to
     Api.chat. Returns null when no canceller was injected — callers then
     just let Api allocate its own epoch. (It used to return a locally invented
     1 in that case, which Api.chat would compare against its own 0 and judge
     STALE, silently discarding the first reply.) */
  function bumpEpoch(reason) {
    _epoch = _cancelTurn ? _cancelTurn(reason) : null;
    return _epoch;
  }

  var Turn = {
    IDLE: IDLE, THINKING: THINKING, SPEAKING: SPEAKING,

    /* ------------------------------------------------------------- ports */
    setSynth: function (fn) { _synth = (typeof fn === 'function') ? fn : null; },
    setPlayer: function (fn) { _player = (typeof fn === 'function') ? fn : null; },
    setTurnCanceller: function (fn) { _cancelTurn = (typeof fn === 'function') ? fn : null; },
    on: function (fn) {
      if (typeof fn !== 'function') return function () {};
      _subs.push(fn);
      return function () { var i = _subs.indexOf(fn); if (i >= 0) _subs.splice(i, 1); };
    },

    /* ------------------------------------------------------------- state */
    state: function () { return _state; },
    isSpeaking: function () { return _state === SPEAKING; },
    isBusy: function () { return _state !== IDLE; },
    epoch: function () { return _epoch; },
    waiting: function () { return _waiting.length; },
    activeIntentId: function () { return _active ? _active.id : null; },

    /* ------------------------------------------------------------- turns
       Start of a user turn: whatever she was saying (and everything queued
       behind it) is superseded, and the caller gets the epoch to hand to
       Api.chat. Returns null when no canceller was injected — callers then
       just let Api allocate its own epoch. */
    beginTurn: function (reason) {
      Turn.stopAll(reason || 'new-turn');
      _epoch = bumpEpoch(reason || 'new-turn');
      setState(THINKING);
      return _epoch;
    },

    /* The reply landed (or failed): back to idle so barge-in can arm again. */
    finishTurn: function () {
      if (_state === THINKING) setState(IDLE);
    },

    /* ------------------------------------------------------------ speech
       Returns the intent handle immediately; playback is asynchronous. */
    speak: function (text, opts) {
      opts = opts || {};
      if (text == null || text === '') return null;
      var intent = {
        id: ++_seq,
        text: String(text),
        priority: (opts.priority != null) ? Number(opts.priority) : 1,
        ownerId: opts.ownerId || 'chat',
        behavior: opts.behavior || 'queue',
        meta: { mode: opts.mode, emotion: opts.emotion, fx: opts.fx }
      };
      if (_active) {
        var cutIn = intent.behavior === 'replace' ||
                    (intent.behavior === 'interrupt' && intent.priority >= _active.priority);
        if (!cutIn) {
          _waiting.push(intent);
          emit({ type: 'queue', intent: intent });
          return intent;
        }
        cancelActive('preempted');
      }
      run(intent);
      return intent;
    },

    /* ------------------------------------------------------------ stops */
    cancelIntent: function (id, reason) {
      var i;
      for (i = _waiting.length - 1; i >= 0; i--) {
        if (_waiting[i].id === id) { _waiting.splice(i, 1); return true; }
      }
      if (_active && _active.id === id) { cancelActive(reason); promote(); return true; }
      return false;
    },

    /* Cut the current utterance; queued ones still play (airi's `interrupt` vs
       `stopAll` distinction). It is also the architecture's single interrupt
       exit, so it invalidates a reply still on the wire: bumping the epoch
       aborts the in-flight XHR, which is what makes "she stops because you
       started talking" true even while she is only *thinking*. Without this,
       a caller that interrupts during THINKING (the stop button, vad.js's
       onset) left the request running and the reply landed afterwards. */
    interrupt: function (reason) {
      var why = reason || 'interrupt';
      bumpEpoch(why);
      var had = cancelActive(why);
      promote();
      return had;
    },

    /* Cut everything: current + queued. This is what a barge-in and a new user
       turn both use. */
    stopAll: function (reason) {
      var had = cancelActive(reason || 'stop-all');
      var dropped = _waiting.length;
      _waiting.length = 0;
      if (dropped) emit({ type: 'drop', count: dropped, reason: reason || 'stop-all' });
      if (had || dropped || _state !== IDLE) setState(IDLE);
      return had || dropped > 0;
    }
  };

  global.Turn = Turn;
})(typeof window !== 'undefined' ? window : globalThis);
