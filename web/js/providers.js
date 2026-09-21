/* Speech provider registry: one row per backend.

   Why this exists
   ---------------
   Adding a provider used to mean editing three hand-written lists that all
   encoded the same fact — which credential fields belong to which provider:
     * Api.speak's dispatch (_qwenSpeak / _fishSpeak / the openai path)
     * App._testTts's ternary chain (provider → key, provider → model)
     * App.buildSettings' select options and field block
   Forgetting one is exactly the bug AUDIT 6.9 records: switching provider kept
   reading the previous baseUrl/key and the endpoint answered 401/404. One row
   per provider, and one resolver both callers share, makes that class of bug
   unrepresentable instead of merely fixed.

   Shape follows airi's provider definitions: a row yields the call parameters
   and the capability flags; the transport call is generic. Local engines are
   declared the same way as cloud ones, so an offline engine is not a special
   case in the caller (airi does the same for VOICEVOX / AivisSpeech).

   Layer: io. It never touches the DOM, Config or App — the caller passes the
   resolved settings in (`credentials(ttsCfg)`), which is also what lets
   scripts/voice_regression.js exercise every row headlessly.
*/
(function (global) {
  'use strict';

  /* Every field name here must be the provider's OWN namespace. Sharing a
     field between providers is what let a switch keep the old endpoint. */
  var ROWS = [
    {
      id: 'openai', kind: 'tts',
      label: 'settings.tts.provider.openai',
      creds: { baseUrl: 'tts.baseUrl', apiKey: 'tts.apiKey',
               model: 'tts.modelPreset', modelClone: 'tts.modelClone', voice: 'tts.presetVoice' },
      capabilities: { instructions: true, emotion: false, clone: true, local: false }
    },
    {
      id: 'openrouter', kind: 'tts',
      label: 'settings.tts.provider.openrouter',
      creds: { baseUrl: 'tts.openrouterBaseUrl', apiKey: 'tts.openrouterApiKey',
               model: 'tts.openrouterModel', modelClone: 'tts.openrouterModelClone', voice: 'tts.openrouterVoice' },
      capabilities: { instructions: false, emotion: false, clone: true, local: false },
      defaults: { baseUrl: 'https://openrouter.ai/api/v1', model: 'mistralai/voxtral-mini-tts-2603', modelClone: 'fish-audio/s2.1-pro-free:free', voice: 'en_paul_neutral' }
    },
    {
      id: 'qwen', kind: 'tts',
      label: 'settings.tts.provider.qwen',
      creds: { baseUrl: 'tts.qwenBaseUrl', apiKey: 'tts.qwenApiKey',
               model: 'tts.qwenModel', voice: 'tts.qwenVoice' },
      capabilities: { instructions: true, emotion: false, clone: true, local: false },
      defaults: { model: 'qwen3-tts-flash' }
    },
    {
      id: 'fish', kind: 'tts',
      label: 'settings.tts.provider.fish',
      creds: { baseUrl: 'tts.fishBaseUrl', apiKey: 'tts.fishApiKey',
               model: 'tts.fishModel', voice: 'tts.fishVoice',
               voiceAsmr: 'tts.fishVoiceAsmr' },
      capabilities: { instructions: true, emotion: true, clone: true, local: false },
      /* The current API's engine id — the older surface names engines
         differently, so api.js keeps a per-surface default too (this one is
         what the settings page's own "test TTS" call resolves to). */
      defaults: { model: 's2.1-pro-free' }
    },
    /* Local engines. AivisSpeech speaks VOICEVOX's HTTP protocol (it is a
       compatible engine), so both rows share one implementation — that is the
       whole point of a table. No API key: nothing leaves the machine. */
    {
      id: 'voicevox', kind: 'tts',
      label: 'settings.tts.provider.voicevox',
      creds: { baseUrl: 'tts.voicevoxBaseUrl', voice: 'tts.voicevoxVoice' },
      defaults: { baseUrl: 'http://127.0.0.1:50021/', voice: '0' },
      capabilities: { instructions: false, emotion: false, clone: false, local: true }
    },
    {
      id: 'aivis', kind: 'tts',
      label: 'settings.tts.provider.aivis',
      creds: { baseUrl: 'tts.aivisBaseUrl', voice: 'tts.aivisVoice' },
      defaults: { baseUrl: 'http://127.0.0.1:10101/', voice: '0' },
      capabilities: { instructions: false, emotion: false, clone: false, local: true }
    },
    /* --------------------------------------------------------------- stt
       Speech-to-text as a provider, the way airi keeps it, instead of the
       browser's cloud recogniser (which is absent in Electron and unusable in
       the APK — measured, see web/js/stt.js). One row, because what we
       implement is the one shape that matters: an OpenAI-compatible
       POST /audio/transcriptions taking a multipart `file`. The player points
       baseUrl at their own endpoint and fills the model id; the default is the
       canonical id of that API. No local engine — a local ASR needs a model
       runtime, which is a separate spike (docs §8). */
    {
      id: 'whisper', kind: 'stt',
      label: 'settings.stt.provider.whisper',
      creds: { baseUrl: 'stt.baseUrl', apiKey: 'stt.apiKey', model: 'stt.model' },
      defaults: { model: 'whisper-1' },
      capabilities: { local: false }
    }
  ];

  var BY_ID = {};
  ROWS.forEach(function (r) { BY_ID[r.id] = r; });

  function pick(tts, field, fallback) {
    if (!field) return '';
    var v = tts ? tts[field.split('.').pop()] : '';
    if (v == null || v === '') return fallback == null ? '' : fallback;
    return String(v);
  }

  /* VOICEVOX-compatible engines: /audio_query returns the synthesis settings
     for a text + style, /synthesis renders them to WAV. Both are POSTs to the
     engine's own origin, so this needs no proxy — but it does need the engine
     to allow cross-origin calls (the page origin is not the engine's). That is
     an engine-side setting, and the error below says so instead of reporting a
     bare network failure. */
  function voicevoxSpeak(row, ctx) {
    var base = String(ctx.creds.baseUrl || '').trim();
    if (!base) return Promise.reject(named('NO_URL', row.id));
    base = base.replace(/\/+$/, '') + '/';
    var style = String(ctx.creds.voice || '').trim() || '0';
    var text = encodeURIComponent(String(ctx.text || ''));

    function fail(what, status) {
      var e = new Error(row.id + ': ' + what + (status ? ' (HTTP ' + status + ')' : ''));
      e.hint = 'local-engine';
      return e;
    }

    return ctx.fetch(base + 'audio_query?text=' + text + '&speaker=' + encodeURIComponent(style),
                     { method: 'POST' })
      .then(function (r) {
        if (!r.ok) throw fail('audio_query 失败', r.status);
        return r.json();
      })
      .then(function (query) {
        return ctx.fetch(base + 'synthesis?speaker=' + encodeURIComponent(style), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(query)
        });
      })
      .then(function (r) {
        if (!r.ok) throw fail('synthesis 失败', r.status);
        return r.blob();
      })
      .then(function (blob) { return URL.createObjectURL(blob); })
      .catch(function (e) {
        /* A bare "failed to fetch" here almost always means the engine is not
           running or refuses cross-origin calls — say both. */
        if (e && e.hint === 'local-engine') throw e;
        var err = new Error(row.id + ': 连不上本地引擎（未启动，或引擎未允许跨源调用）');
        err.hint = 'local-engine';
        err.cause = e;
        throw err;
      });
  }

  function named(code, id) {
    var e = new Error(code);
    e.provider = id;
    return e;
  }

  var Providers = {
    rows: ROWS,

    get: function (id) { return BY_ID[id] || null; },

    ids: function (kind) {
      return ROWS.filter(function (r) { return !kind || r.kind === kind; })
                 .map(function (r) { return r.id; });
    },

    /* The single resolver: given the whole tts settings object, return the
       ACTIVE provider's own parameters. Nothing else may read these fields
       directly — that is what keeps a provider switch from carrying the
       previous endpoint across. */
    credentials: function (tts) {
      tts = tts || {};
      var row = BY_ID[tts.provider] || BY_ID.openai;
      var c = row.creds;
      var model = pick(tts, c.model, row.defaults && row.defaults.model);
      if (row.id === 'openai' && String(tts.mode || '') === 'clone') {
        model = pick(tts, c.modelClone, model);
      }
      var key = pick(tts, c.apiKey);
      if (!key && row.id === 'openrouter') {
        try {
          if (global.Config && Config.section) {
            key = (Config.section('llm') || {}).apiKey || '';
          }
        } catch (e) {}
      }
      return {
        id: row.id,
        capabilities: row.capabilities,
        baseUrl: pick(tts, c.baseUrl, row.defaults && row.defaults.baseUrl),
        apiKey: key,
        model: model,
        voice: pick(tts, c.voice, row.defaults && row.defaults.voice),
        /* Only fish names one today; '' on every other row. */
        voiceAsmr: pick(tts, c.voiceAsmr)
      };
    },

    /* The same resolver for the speech-input side. It takes the whole `stt`
       settings section, and like the TTS one it returns only the ACTIVE row's
       own fields, so pointing the transcriber at a new host cannot carry the
       previous key or URL along. */
    sttCredentials: function (stt) {
      stt = stt || {};
      var row = BY_ID[stt.provider] && BY_ID[stt.provider].kind === 'stt'
        ? BY_ID[stt.provider]
        : ROWS.filter(function (r) { return r.kind === 'stt'; })[0];
      if (!row) return { id: '', capabilities: {}, baseUrl: '', apiKey: '', model: '' };
      var c = row.creds;
      return {
        id: row.id,
        capabilities: row.capabilities,
        baseUrl: pick(stt, c.baseUrl, row.defaults && row.defaults.baseUrl),
        apiKey: pick(stt, c.apiKey),
        model: pick(stt, c.model, row.defaults && row.defaults.model)
      };
    },

    idsOfKind: function (kind) {
      return ROWS.filter(function (r) { return r.kind === kind; })
                 .map(function (r) { return r.id; });
    },

    /* Synthesize through a local engine. Returns a blob URL, like the cloud
       paths do. `ctx` = { text, fetch } (+ creds from `credentials`). */
    speakLocal: function (creds, ctx) {
      var row = BY_ID[creds && creds.id];
      if (!row || !row.capabilities.local) return Promise.reject(named('NOT_LOCAL', creds && creds.id));
      return voicevoxSpeak(row, { text: ctx.text, fetch: ctx.fetch, creds: creds });
    },

    isLocal: function (id) {
      var row = BY_ID[id];
      return !!(row && row.capabilities.local);
    }
  };

  global.Providers = Providers;
})(typeof window !== 'undefined' ? window : globalThis);
