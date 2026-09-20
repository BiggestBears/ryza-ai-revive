/* Alarms: APK layout assets/audio/alarm/<locale>/<normal|whisper>/<type>/<tod>/<n>.m4a
   + sibling .env.json (durationMs, windowMs, envelope[]) for lipsync.
   The clip catalog (VoiceBank) itself lives in audio.js with the rest of
   the sound routing. */
(function (global) {
  'use strict';

  var KEY = 'ryza.alarms.v1';
  var TYPES = ['goodMorning', 'playWithMe', 'task', 'wellDone'];
  var STYLES = ['normal', 'whisper'];
  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  /* Voice-table band name for an hour. The boundaries are NOT redeclared here:
     Util.hourToTod owns them (shared with the scene bands), and Util.TOD_VOICE
     maps the scene vocabulary to the long names this audio tree uses. */
  function todForHour(h) {
    return Util.todForVoice(h);
  }

  /* Host-injected editor opener: the alarm list's own view code must not reach
     into App (see scripts/layering_check.js). Inert by default. */
  var _edit = null;

  /* The native bridge (the Android shell's RyzaAlarm JavascriptInterface). When
     it exists IT is the firing authority: it survives the process being killed
     and can wake the screen, which a setInterval inside a WebView cannot do at
     all. The web model stays the single source of truth for the list — every
     mutation is pushed down as JSON, so the two cannot drift.
     Absent (browser, Electron) = the old in-page scheduler, unchanged. */
  var _native = null;
  var _onFire = null;

  function nativeReady() {
    try { return !!(_native && (!_native.isSupported || _native.isSupported())); }
    catch (e) { return false; }
  }

  /* What the native side plays. It has no voice-bank index, so the clip is
     resolved here — for the alarm's OWN hour, which is the band it will ring in
     (the clip tree is banded morning/daytime/evening/night). */
  function clipFor(a) {
    var h = parseInt(String(a.time || '7:00').slice(0, 2), 10);
    if (isNaN(h)) h = 7;
    try { return VoiceBank.pick(a.type, a.style || 'normal', todForHour(h)) || ''; }
    catch (e) { return ''; }
  }

  function push() {
    if (!nativeReady() || typeof _native.schedule !== 'function') return false;
    try {
      _native.schedule(JSON.stringify(Alarm.items.map(function (a) {
        return {
          id: a.id, time: a.time, days: a.days || [],
          enabled: a.enabled !== false,
          type: a.type, style: a.style || 'normal',
          snoozeMin: a.snoozeMin == null ? 5 : a.snoozeMin,
          volume: a.volume == null ? 1 : a.volume,
          vibrate: a.vibrate !== false,
          audio: clipFor(a)
        };
      })));
      return true;
    } catch (e) { return false; }
  }

  var Alarm = {
    setEditor: function (fn) { _edit = (typeof fn === 'function') ? fn : null; },
    /* Accepts the native bridge, or null to stay in-page. */
    setNative: function (b) { _native = b || null; },
    nativeReady: nativeReady,
    items: [],
    _timer: null,
    _fired: {},

    load: function () {
      try { Alarm.items = JSON.parse(localStorage.getItem(KEY) || '[]'); }
      catch (e) { Alarm.items = []; }
      /* First run on a host that already has native alarms (the app was
         reinstalled, or the page's storage was cleared): adopt them rather than
         showing an empty list while the system keeps ringing. */
      if (!Alarm.items.length && nativeReady() && typeof _native.list === 'function') {
        try {
          var remote = JSON.parse(_native.list() || '[]');
          if (Array.isArray(remote) && remote.length) {
            Alarm.items = remote;
            Alarm.save();
          }
        } catch (e) { /* keep the empty list */ }
      }
      return Alarm.items;
    },
    save: function () {
      try { localStorage.setItem(KEY, JSON.stringify(Alarm.items)); } catch (e) {}
      /* Every mutation funnels through here, so this is the one place the native
         schedule needs to be refreshed. */
      push();
    },

    add: function (a) {
      a.id = 'a' + Date.now();
      a.enabled = a.enabled !== false;
      if (a.snoozeMin == null) a.snoozeMin = 5;
      if (a.volume == null) a.volume = 1;
      if (a.vibrate == null) a.vibrate = true;
      Alarm.items.push(a);
      Alarm.save();
    },
    remove: function (id) {
      Alarm.items = Alarm.items.filter(function (x) { return x.id !== id; });
      Alarm.save();
    },
    toggle: function (id) {
      Alarm.items.forEach(function (x) { if (x.id === id) x.enabled = !x.enabled; });
      Alarm.save();
    },
    get: function (id) {
      return Alarm.items.filter(function (x) { return x.id === id; })[0] || null;
    },
    update: function (id, patch) {
      Alarm.items.forEach(function (x) {
        if (x.id !== id) return;
        Object.keys(patch).forEach(function (k) { x[k] = patch[k]; });
      });
      Alarm.save();
    },

    start: function (onFire) {
      _onFire = (typeof onFire === 'function') ? onFire : null;
      if (Alarm._timer) { clearInterval(Alarm._timer); Alarm._timer = null; }
      /* Native host: the system owns the schedule now. Running the in-page tick
         as well would double-fire every alarm. */
      if (nativeReady()) { push(); return; }
      Alarm._timer = setInterval(function () { Alarm._tick(_onFire); }, 5000);
      Alarm._tick(_onFire);
    },

    /* Called when the native side says an alarm fired while the page is alive.
       The list is not touched: native re-arms the next occurrence itself. */
    _nativeFire: function (one) {
      var a = (one && one.id) ? Alarm.get(one.id) : null;
      if (!a) return false;
      var clip = clipFor(a);
      if (_onFire) { _onFire(a, clip); return true; }
      return false;
    },

    _tick: function (onFire) {
      var now = new Date();
      var hhmm = String(now.getHours()).padStart(2, '0') + ':' +
                 String(now.getMinutes()).padStart(2, '0');
      var dow = now.getDay();
      var stamp = now.toDateString() + ' ' + hhmm;
      Alarm.items.forEach(function (a) {
        if (!a.enabled) return;
        var t = a._snoozeUntil || a.time;
        if (t !== hhmm) return;
        if (!a._snoozeUntil && Array.isArray(a.days) && a.days.length &&
            a.days.indexOf(dow) === -1) return;
        if (Alarm._fired[stamp + a.id]) return;
        Alarm._fired[stamp + a.id] = true;
        a._snoozeUntil = null;
        Alarm.save();
        var clip = VoiceBank.pick(a.type, a.style || 'normal', todForHour(now.getHours()));
        onFire && onFire(a, clip);
      });
    },

    snooze: function (a) {
      var min = Math.max(1, parseInt(a.snoozeMin, 10) || 5);
      var d = new Date();
      d.setMinutes(d.getMinutes() + min);
      a._snoozeUntil = String(d.getHours()).padStart(2, '0') + ':' +
                       String(d.getMinutes()).padStart(2, '0');
      Alarm.save();
    },

    loadEnv: function (clip) {
      var p = VoiceBank.envPath(clip);
      if (!p) return Promise.resolve(null);
      return fetch(p).then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    },

    render: function (root, onPlay) {
      root.innerHTML = '';
      if (!Alarm.items.length) {
        root.innerHTML = '<div class="empty">' + I18n.t('alarm.empty') + '</div>';
        return;
      }
      Alarm.items.slice().sort(function (x, y) { return x.time < y.time ? -1 : 1; })
        .forEach(function (a) {
          var el = document.createElement('div');
          el.className = 'card' + (a.enabled ? '' : ' done');
          var days = (a.days && a.days.length)
            ? a.days.slice().sort().map(function (d) { return WEEK[d]; }).join(' ')
            : I18n.t('alarm.everyday');
          el.innerHTML =
            '<div class="card-title"><span class="t-time"></span>' +
            '<span class="tag"></span><span class="tag leaf"></span></div>' +
            '<div class="card-sub"><span class="t-days"></span></div>' +
            '<div class="card-acts">' +
            '<button class="mini-btn t-play"></button>' +
            '<button class="mini-btn t-edit"></button>' +
            '<button class="mini-btn t-toggle"></button>' +
            '<button class="mini-btn t-del"></button></div>';
          el.querySelector('.t-time').textContent = a.time;
          el.querySelector('.t-days').textContent = days +
            (a.snoozeMin ? ' · ' + I18n.t('alarm.snooze') + ' ' + a.snoozeMin + I18n.t('alarm.min') : '');
          el.querySelector('.tag').textContent = I18n.t('alarm.type.' + a.type);
          el.querySelector('.tag.leaf').textContent = I18n.t('alarm.style.' + (a.style || 'normal'));
          el.querySelector('.t-play').textContent = I18n.t('alarm.preview');
          el.querySelector('.t-edit').textContent = I18n.t('form.edit');
          el.querySelector('.t-toggle').textContent = a.enabled ? I18n.t('alarm.on') : I18n.t('alarm.off');
          el.querySelector('.t-del').textContent = I18n.t('alarm.delete');
          el.querySelector('.t-play').onclick = function () {
            var clip = VoiceBank.pick(a.type, a.style || 'normal', todForHour(new Date().getHours()));
            clip && onPlay && onPlay(clip);
          };
          el.querySelector('.t-edit').onclick = function () {
            if (_edit) _edit(a.id);
          };
          el.querySelector('.t-toggle').onclick = function () {
            Alarm.toggle(a.id); Alarm.render(root, onPlay);
          };
          el.querySelector('.t-del').onclick = function () {
            Alarm.remove(a.id); Alarm.render(root, onPlay);
          };
          root.appendChild(el);
        });
    },

    TYPES: TYPES,
    STYLES: STYLES,
    WEEK: WEEK,
    todForHour: todForHour
  };

  global.Alarm = Alarm;
})(window);
