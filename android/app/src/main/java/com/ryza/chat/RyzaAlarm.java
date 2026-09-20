package com.ryza.chat;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.lang.ref.WeakReference;

/**
 * ============================================================================
 *  RyzaAlarm — JS bridge contract (registered on the WebView as "RyzaAlarm")
 * ============================================================================
 *
 * The native side is the SINGLE source of truth for firing alarms. The web
 * layer's Alarm.start() timer only runs while the page is alive; once this
 * bridge is present the page must stop using it as a scheduler and let the
 * native side drive. The page keeps ownership of the alarm list UI + clips.
 *
 * INSTALLATION (done by MainActivity, nothing for JS to do):
 *   web.addJavascriptInterface(new RyzaAlarm(activity), "RyzaAlarm");
 *
 * ----------------------------------------------------------------------------
 * ALARM JSON SHAPE (accepted by schedule(); returned by list()/onFire)
 * ----------------------------------------------------------------------------
 *   id        string   REQUIRED. Stable id, e.g. "a1758000000000" (web Alarm.add).
 *   time      string   REQUIRED. Local 24h "HH:MM" (also accepts "H:MM").
 *   days      int[]    optional. 0=Sunday .. 6=Saturday (Date.getDay() order,
 *                      same as web Alarm.days). Absent/empty = every day.
 *   enabled   boolean  optional, default true. false cancels the native schedule.
 *   type      string   optional, default "goodMorning". Mirror of web Alarm.TYPES:
 *                      "goodMorning" | "playWithMe" | "task" | "wellDone".
 *   style     string   optional, default "normal". Mirror of web Alarm.STYLES:
 *                      "normal" | "whisper".
 *   snoozeMin int      optional, default 5 (minutes).
 *   volume    number   optional, 0..1, default 1 (USAGE_ALARM stream of the ring).
 *   vibrate   boolean  optional, default true.
 *   audio     string   optional, WEB-OWNED. Asset-relative path such as
 *                      "assets/audio/alarm/ja/normal/goodMorning/morning/1.m4a"
 *                      (served over the app's local 127.0.0.1 server) OR an
 *                      absolute http(s) URL. The web layer resolves this with
 *                      VoiceBank.pick(type, style, Util.todForVoice(hour)).
 *                      Empty/absent = vibrate only; no audio ships in android/.
 *   ...       any      Any other field is stored verbatim and returned by list().
 * Missing optional fields are filled in with the defaults above on schedule().
 *
 * ----------------------------------------------------------------------------
 * METHODS (all return synchronously; they may be called from any JS thread)
 * ----------------------------------------------------------------------------
 *   schedule(String json) -> String
 *       json is ONE alarm object or an ARRAY of them. Upserts each into the
 *       native store and (re)arms it; an existing schedule + snooze for the id
 *       is replaced. Returns a JSON object:
 *         { "ok": boolean,        // true iff every item applied
 *           "scheduled": int,     // how many applied
 *           "exact": boolean,     // canScheduleExact() at call time
 *           "errors": [String] }  // per-item failure messages, [] on success
 *       Invalid item (missing id, malformed time) is reported in "errors";
 *       it does not throw into JS and does not abort the remaining array.
 *
 *   cancel(String id) -> boolean       // true if an alarm with that id existed
 *   cancelAll() -> boolean             // true; drops the whole native store
 *   snooze(String id) -> boolean       // EXTRA (beyond the required seven).
 *                                      // Arms a one-shot snooze
 *                                      // (now + snoozeMin, default 5) and
 *                                      // clears the notification. The web layer
 *                                      // MUST call this when the user taps
 *                                      // snooze in its FOREGROUND ring overlay —
 *                                      // otherwise the native re-fire never
 *                                      // happens (the page's own timer must not
 *                                      // be used as a scheduler).
 *   list() -> String                   // JSON array, same shape as schedule()
 *   canScheduleExact() -> boolean      // true on API<31; on API 31+ reflects
 *                                      // AlarmManager.canScheduleExactAlarms()
 *   requestExactPermission() -> boolean// true if exact already allowed or the
 *                                      // system settings page was opened; also
 *                                      // asks POST_NOTIFICATIONS on API 33+
 *   isSupported() -> boolean           // true on this Android shell (the web
 *                                      // layer should gate its native path on it)
 *
 * ----------------------------------------------------------------------------
 * NATIVE -> JS: FOREGROUND FIRE
 * ----------------------------------------------------------------------------
 * When a scheduled alarm fires while MainActivity is resumed, the native side
 * does NOT raise its own ring screen. It calls, on the WebView UI thread:
 *
 *     window.RyzaAlarmNative.onFire( <the alarm object> )
 *
 * The page MUST expose exactly:
 *     window.RyzaAlarmNative = window.RyzaAlarmNative || {};
 *     window.RyzaAlarmNative.onFire = function (alarm) { ... };
 * e.g. show the web ring overlay and play the alarm's "audio" clip. The call is
 * fire-and-forget (its return value is ignored). If the hook is missing or
 * throws, native falls back to its own full-screen AlarmRingActivity so the
 * alarm is never lost. Background/process-dead fires never reach JS: they are
 * shown by the native ring screen + full-screen notification, and JS learns
 * about them only through list()/schedule() the next time it runs.
 * ============================================================================
 */
public final class RyzaAlarm {
    private static final int REQ_POST_NOTIFICATIONS = 9001;

    private static WeakReference<WebView> sWeb;
    private static volatile boolean sForeground;
    private static volatile boolean sAskedNotifications;

    private final WeakReference<Activity> activity;

    RyzaAlarm(Activity a) {
        this.activity = new WeakReference<>(a);
    }

    /* ------------------------------------------------- wiring (called by MainActivity) */

    /** Registers this bridge on the WebView and remembers it for onFire delivery. */
    static void attach(Activity activity, WebView web) {
        sWeb = new WeakReference<>(web);
        web.addJavascriptInterface(new RyzaAlarm(activity), "RyzaAlarm");
    }

    static void detach() {
        sWeb = null;
        sForeground = false;
    }

    static void setForeground(boolean foreground) {
        sForeground = foreground;
    }

    static boolean isForeground() {
        return sForeground;
    }

    /**
     * Forwards a foreground fire to the page. Returns true when a live WebView
     * was found and the call was dispatched; if the page has not wired
     * onFire, the callback raises the native ring screen instead (still from
     * the foreground, so the activity start is allowed).
     */
    static boolean deliverFire(final Context ctx, final JSONObject alarm) {
        final WebView w = sWeb == null ? null : sWeb.get();
        if (w == null) return false;
        final String json = jsSource(alarm.toString());
        w.post(() -> {
            String js = "(function(){var h=window.RyzaAlarmNative;"
                    + "if(h&&typeof h.onFire==='function'){try{h.onFire(" + json + ");return 'ok';}"
                    + "catch(e){return 'err';}}return 'none';})()";
            try {
                w.evaluateJavascript(js, value -> {
                    if (value == null || value.contains("none") || value.contains("err")) {
                        fallbackRing(ctx, alarm);
                    }
                });
            } catch (Exception e) {
                fallbackRing(ctx, alarm);
            }
        });
        return true;
    }

    private static void fallbackRing(Context ctx, JSONObject alarm) {
        if (ctx == null || alarm == null) return;
        AlarmScheduler.postRingNotification(ctx, alarm);
        Activity a = (ctx instanceof Activity) ? (Activity) ctx : null;
        try {
            Intent ring = new Intent(ctx, AlarmRingActivity.class);
            ring.setAction(AlarmScheduler.ACTION_FIRE);
            ring.putExtra(AlarmScheduler.EXTRA_ID, alarm.optString("id", ""));
            ring.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (a != null) a.startActivity(ring); else ctx.startActivity(ring);
        } catch (Exception ignored) {}
    }

    /* ---------------------------------------------------------- JS methods */

    @JavascriptInterface
    public String schedule(String json) {
        Context c = context();
        JSONObject res = new JSONObject();
        JSONArray errors = new JSONArray();
        int n = 0;
        try {
            if (c == null) throw new JSONException("activity is gone");
            Object parsed = new JSONTokener(json == null ? "" : json).nextValue();
            if (parsed instanceof JSONArray) {
                JSONArray arr = (JSONArray) parsed;
                for (int i = 0; i < arr.length(); i++) {
                    try {
                        apply(c, arr.getJSONObject(i));
                        n++;
                    } catch (Exception e) {
                        errors.put("[" + i + "] " + String.valueOf(e.getMessage()));
                    }
                }
            } else if (parsed instanceof JSONObject) {
                apply(c, (JSONObject) parsed);
                n = 1;
            } else {
                throw new JSONException("expected an alarm object or an array of them");
            }
            res.put("ok", errors.length() == 0).put("scheduled", n)
                    .put("exact", AlarmScheduler.canScheduleExact(c)).put("errors", errors);
        } catch (Exception e) {
            try {
                res.put("ok", false).put("scheduled", 0)
                        .put("exact", c != null && AlarmScheduler.canScheduleExact(c))
                        .put("errors", new JSONArray().put(String.valueOf(e.getMessage())));
            } catch (JSONException ignored) {}
        }
        maybeAskNotifications(c);
        return res.toString();
    }

    private void apply(Context c, JSONObject a) throws JSONException {
        String id = a.optString("id", "");
        if (id.isEmpty()) throw new JSONException("alarm \"id\" is required");
        if (!AlarmScheduler.isValidTime(a)) throw new JSONException("alarm \"time\" must be HH:MM");
        if (!a.has("enabled")) a.put("enabled", true);
        if (!a.has("snoozeMin")) a.put("snoozeMin", AlarmScheduler.DEFAULT_SNOOZE_MIN);
        if (!a.has("volume")) a.put("volume", 1);
        if (!a.has("vibrate")) a.put("vibrate", true);
        if (!a.has("style")) a.put("style", "normal");
        if (!a.has("type")) a.put("type", "goodMorning");
        AlarmStore.upsert(c, a);
        AlarmScheduler.reset(c, id);       // drop a stale schedule + snooze for this id
        AlarmScheduler.schedule(c, a);
    }

    @JavascriptInterface
    public boolean cancel(String id) {
        Context c = context();
        if (c == null || id == null || id.isEmpty()) return false;
        boolean existed = AlarmStore.get(c, id) != null;
        AlarmScheduler.cancel(c, id);
        AlarmStore.remove(c, id);
        return existed;
    }

    @JavascriptInterface
    public boolean cancelAll() {
        Context c = context();
        if (c == null) return false;
        AlarmScheduler.cancelAll(c);
        return true;
    }

    @JavascriptInterface
    public boolean snooze(String id) {
        Context c = context();
        if (c == null || id == null || id.isEmpty()) return false;
        if (AlarmStore.get(c, id) == null) return false;
        AlarmScheduler.cancelNotification(c, id);
        AlarmScheduler.snooze(c, id);
        return true;
    }

    @JavascriptInterface
    public String list() {
        Context c = context();
        return c == null ? "[]" : AlarmStore.load(c).toString();
    }

    @JavascriptInterface
    public boolean canScheduleExact() {
        Context c = context();
        return c != null && AlarmScheduler.canScheduleExact(c);
    }

    @JavascriptInterface
    public boolean requestExactPermission() {
        final Activity a = activity.get();
        Context c = context();
        if (c == null) return false;
        maybeAskNotifications(c);
        if (AlarmScheduler.canScheduleExact(c)) return true;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true; // no such permission
        if (a == null) return false;
        a.runOnUiThread(() -> {
            try {
                Intent i = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
                i.setData(Uri.parse("package:" + a.getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                a.startActivity(i);
            } catch (Exception ignored) {}
        });
        return true;
    }

    @JavascriptInterface
    public boolean isSupported() {
        return true;
    }

    /* ------------------------------------------------------------ helpers */

    private Context context() {
        Activity a = activity.get();
        return a;
    }

    /**
     * POST_NOTIFICATIONS is API 33+ and is needed for the background full-screen
     * fallback notification. Asked once per process, on the UI thread, and only
     * when the app does not already hold it.
     */
    private void maybeAskNotifications(Context c) {
        if (c == null || Build.VERSION.SDK_INT < 33) return;
        if (sAskedNotifications || AlarmScheduler.canPostNotifications(c)) return;
        final Activity a = activity.get();
        if (a == null) return;
        sAskedNotifications = true;
        a.runOnUiThread(() -> {
            try {
                a.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},
                        REQ_POST_NOTIFICATIONS);
            } catch (Exception ignored) {}
        });
    }

    /** Keeps the JSON source safe to paste into a JS expression (U+2028/29). */
    private static String jsSource(String json) {
        return json.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
    }
}
