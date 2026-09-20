package com.ryza.chat;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * Persistent alarm list + snooze table, stored as JSON in SharedPreferences so
 * pending alarms survive the process being killed AND a reboot (the web layer's
 * localStorage copy dies with the WebView; this is the copy the native
 * scheduler reads at BOOT_COMPLETED).
 *
 * The stored objects are exactly what the JS bridge received (see RyzaAlarm's
 * contract comment) — unknown/extra fields are preserved verbatim so list()
 * can round-trip the web layer's own model without losing data. Fields the
 * scheduler understands: id, time, days, enabled, type, style, snoozeMin,
 * volume, vibrate, audio.
 *
 * One SharedPreferences file, two keys:
 *   items   -> JSON array of alarm objects
 *   snoozes -> JSON object { alarmId: fireAtEpochMillis } (transient one-shots)
 *
 * All access is synchronized: the @JavascriptInterface callbacks arrive on a
 * WebView binder thread while BOOT_COMPLETED runs on the main thread.
 */
final class AlarmStore {
    private static final String PREFS = "ryza_alarms";
    private static final String KEY_ITEMS = "items";
    private static final String KEY_SNOOZE = "snoozes";

    private AlarmStore() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Parsed alarm list; never null. */
    static synchronized JSONArray load(Context c) {
        String raw = prefs(c).getString(KEY_ITEMS, "[]");
        try {
            JSONArray a = new JSONArray(raw);
            return a;
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    static synchronized void save(Context c, JSONArray items) {
        prefs(c).edit().putString(KEY_ITEMS, items.toString()).apply();
    }

    static JSONObject find(JSONArray items, String id) {
        if (id == null) return null;
        for (int i = 0; i < items.length(); i++) {
            JSONObject o = items.optJSONObject(i);
            if (o != null && id.equals(o.optString("id"))) return o;
        }
        return null;
    }

    static synchronized JSONObject get(Context c, String id) {
        return find(load(c), id);
    }

    /** Insert or replace by id, preserving list order. */
    static synchronized void upsert(Context c, JSONObject alarm) {
        JSONArray items = load(c);
        JSONArray out = new JSONArray();
        String id = alarm.optString("id", "");
        boolean replaced = false;
        for (int i = 0; i < items.length(); i++) {
            JSONObject o = items.optJSONObject(i);
            if (o == null) continue;
            if (id.equals(o.optString("id"))) {
                out.put(alarm);
                replaced = true;
            } else {
                out.put(o);
            }
        }
        if (!replaced) out.put(alarm);
        save(c, out);
    }

    static synchronized boolean remove(Context c, String id) {
        JSONArray items = load(c);
        JSONArray out = new JSONArray();
        boolean found = false;
        for (int i = 0; i < items.length(); i++) {
            JSONObject o = items.optJSONObject(i);
            if (o == null) continue;
            if (id != null && id.equals(o.optString("id"))) { found = true; continue; }
            out.put(o);
        }
        if (found) save(c, out);
        return found;
    }

    static synchronized void clear(Context c) {
        prefs(c).edit().remove(KEY_ITEMS).remove(KEY_SNOOZE).apply();
    }

    /* ------------------------------------------------------------ snoozes */

    static synchronized Map<String, Long> snoozes(Context c) {
        Map<String, Long> m = new HashMap<>();
        try {
            JSONObject o = new JSONObject(prefs(c).getString(KEY_SNOOZE, "{}"));
            Iterator<String> it = o.keys();
            while (it.hasNext()) {
                String k = it.next();
                long at = o.optLong(k, 0L);
                if (at > 0L) m.put(k, at);
            }
        } catch (JSONException ignored) {}
        return m;
    }

    static synchronized void putSnooze(Context c, String id, long fireAt) {
        if (id == null) return;
        Map<String, Long> m = snoozes(c);
        m.put(id, fireAt);
        writeSnoozes(c, m);
    }

    static synchronized void clearSnooze(Context c, String id) {
        if (id == null) return;
        Map<String, Long> m = snoozes(c);
        if (m.remove(id) != null) writeSnoozes(c, m);
    }

    private static void writeSnoozes(Context c, Map<String, Long> m) {
        JSONObject o = new JSONObject();
        for (Map.Entry<String, Long> e : m.entrySet()) {
            try { o.put(e.getKey(), e.getValue().longValue()); } catch (JSONException ignored) {}
        }
        prefs(c).edit().putString(KEY_SNOOZE, o.toString()).apply();
    }
}
