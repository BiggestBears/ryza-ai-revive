/* Text-level echo suppression for voice input.

   Why this exists
   ---------------
   The microphone hears her own speech. Browser echo cancellation handles the
   loudspeaker path most of the time, but it cannot help when the recogniser
   hears a *transcript* of what she just said — a room, a headset without AEC,
   or a phone on speaker all produce the same result: her own line comes back as
   if the player had said it, and the character answers herself.

   The mechanism and the parameter values are taken from Project-N.E.K.O
   (Apache-2.0), main_logic/core/_shared.py `_looks_like_recent_ai_echo`: keep
   what she recently said, and drop a transcript that is ≥0.88 similar to it.
   The similarity metric here is an LCS ratio (the same shape as Python's
   difflib.SequenceMatcher.ratio) rather than a bag-of-words score, so the 0.88
   threshold keeps the meaning it was tuned for.

   Layer: voice. Pure logic, no DOM, no timers it does not own — the clock is
   passed in, so the regression can drive a whole conversation deterministically.
*/
(function (global) {
  'use strict';

  /* N.E.K.O.'s values: look back 20 s / 1200 characters, ignore anything
     shorter than 6 normalised characters, and compare against sliding windows
     of at least 10 characters. */
  var LOOKBACK_MS = 20000;
  var LOOKBACK_CHARS = 1200;
  var MIN_TRANSCRIPT_CHARS = 6;
  var MIN_WINDOW_CHARS = 10;
  var THRESHOLD = 0.88;

  var _recent = [];   /* { text, at } oldest first */

  /* Python's [\W_]+ with re.UNICODE: keep letters and digits, drop everything
     else. JS \p{L}\p{N} needs the u flag, so filter instead of substituting. */
  function normalize(s) {
    var out = '';
    s = String(s == null ? '' : s);
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (/[\p{L}\p{N}]/u.test(c)) out += c.toLowerCase();
    }
    return out;
  }

  /* Longest common *subsequence* length over its own length — the ratio
     SequenceMatcher reports for two strings. Two rolling rows, so memory is
     O(min(len)) and a 1200-character comparison stays cheap. */
  function lcsRatio(a, b) {
    if (!a.length || !b.length) return 0;
    var prev = new Uint32Array(b.length + 1);
    var cur = new Uint32Array(b.length + 1);
    for (var i = 1; i <= a.length; i++) {
      for (var j = 1; j <= b.length; j++) {
        cur[j] = (a.charCodeAt(i - 1) === b.charCodeAt(j - 1))
          ? prev[j - 1] + 1
          : (prev[j] > cur[j - 1] ? prev[j] : cur[j - 1]);
      }
      var t = prev; prev = cur; cur = t;
      cur.fill(0);
    }
    return (2 * prev[b.length]) / (a.length + b.length);
  }

  function recentText(now) {
    var cut = now - LOOKBACK_MS;
    var buf = '';
    for (var i = _recent.length - 1; i >= 0; i--) {
      if (_recent[i].at < cut) break;
      buf = _recent[i].text + '\n' + buf;
      if (buf.length >= LOOKBACK_CHARS) break;
    }
    if (buf.length > LOOKBACK_CHARS) buf = buf.slice(buf.length - LOOKBACK_CHARS);
    return buf;
  }

  /* Whole-string first (the common case: the recogniser heard the entire
     line), then a sliding window for the case where only a fragment of her
     sentence came back. */
  function similar(enough, hay) {
    if (lcsRatio(enough, normalize(hay)) >= THRESHOLD) return true;
    var n = enough.length;
    var win = Math.max(MIN_WINDOW_CHARS, n);
    if (hay.length <= win) return false;
    var step = Math.max(1, Math.floor(n / 4));
    for (var i = 0; i + win <= hay.length; i += step) {
      if (lcsRatio(enough, hay.slice(i, i + win)) >= THRESHOLD) return true;
    }
    return false;
  }

  var Echo = {
    LOOKBACK_MS: LOOKBACK_MS,
    LOOKBACK_CHARS: LOOKBACK_CHARS,
    MIN_TRANSCRIPT_CHARS: MIN_TRANSCRIPT_CHARS,
    THRESHOLD: THRESHOLD,

    /* Remember a line she said. Call it when speech starts, not when the audio
       ends, so a very long utterance is covered while it is still playing. */
    remember: function (text, now) {
      var t = String(text == null ? '' : text).trim();
      if (!t) return;
      _recent.push({ text: t, at: now != null ? Number(now) : Date.now() });
      var cut = (_recent[_recent.length - 1].at) - LOOKBACK_MS;
      while (_recent.length && _recent[0].at < cut) _recent.shift();
    },

    /* Should this transcript be thrown away as her own voice coming back? */
    looksLikeEcho: function (transcript, now) {
      var n = normalize(transcript);
      if (n.length < MIN_TRANSCRIPT_CHARS) return false;
      var hay = normalize(recentText(now != null ? Number(now) : Date.now()));
      if (hay.length < MIN_WINDOW_CHARS) return false;
      return similar(n, hay);
    },

    reset: function () { _recent.length = 0; },
    recentCount: function () { return _recent.length; },

    /* exposed for the regression */
    _normalize: normalize,
    _lcsRatio: lcsRatio
  };

  global.Echo = Echo;
})(typeof window !== 'undefined' ? window : globalThis);
