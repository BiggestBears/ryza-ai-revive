package com.ryza.chat;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.drawable.Icon;
import android.os.Build;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;
import java.util.HashMap;
import java.util.Map;

/**
 * AlarmManager scheduling + the alarm notification channel.
 *
 * Design notes (why the pieces look like this):
 *  - A daily/selected-day alarm is a REPEATING alarm in the web model, so after
 *    it fires AlarmReceiver calls schedule() again to arm the next occurrence.
 *  - Exact delivery uses setAlarmClock() (the user-visible alarm API: it also
 *    shows the status-bar clock and is exempt from Doze). Snoozes use
 *    setExactAndAllowWhileIdle() because a 5-minute one-shot should not put a
 *    clock icon in the status bar. Both require the exact-alarm permission on
 *    API 31+; when it is missing we fall back to setAndAllowWhileIdle(), which
 *    is inexact (a window) but never throws and still fires in Doze.
 *  - The fire PendingIntent is explicit (class + action + FLAG_IMMUTABLE), so
 *    the receiver does not need android:exported="true".
 */
final class AlarmScheduler {
    /* Broadcast actions used by AlarmReceiver and the notification buttons. */
    static final String ACTION_FIRE = "com.ryza.chat.action.ALARM_FIRE";
    static final String ACTION_FIRE_SNOOZE = "com.ryza.chat.action.ALARM_FIRE_SNOOZE";
    static final String ACTION_SNOOZE = "com.ryza.chat.action.ALARM_SNOOZE";
    static final String ACTION_DISMISS = "com.ryza.chat.action.ALARM_DISMISS";
    static final String EXTRA_ID = "id";

    /** Notification channel for ringing alarms. */
    static final String CHANNEL_ID = "ryza_alarm";

    /** Used when the alarm JSON omits snoozeMin — the reminder model's default. */
    static final int DEFAULT_SNOOZE_MIN = 5;

    private static final int RC_SHOW = 0x7A01;
    private static final int PI_FLAGS = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;

    private AlarmScheduler() {}

    /* ------------------------------------------------------------ permissions */

    /**
     * SCHEDULE_EXACT_ALARM is API 31+ and, for apps targeting 33+, is NOT
     * granted by default (the user must allow "Alarms & reminders"). Below 31
     * exact alarms need no permission. Never crash when it is missing — the
     * caller falls back to an inexact alarm.
     */
    static boolean canScheduleExact(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        return am != null && am.canScheduleExactAlarms();
    }

    /** POST_NOTIFICATIONS is API 33+; the full-screen fallback needs it. */
    static boolean canPostNotifications(Context c) {
        if (Build.VERSION.SDK_INT < 33) return true;
        return c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    /* ------------------------------------------------------------ scheduling */

    /** JSON key "days" uses the web model's Date.getDay(): 0=Sunday..6=Saturday. */
    private static boolean[] parseDays(JSONArray arr) {
        boolean[] days = new boolean[7];
        if (arr == null) return days;
        for (int i = 0; i < arr.length(); i++) {
            int v = arr.optInt(i, -1);
            if (v >= 0 && v < 7) days[v] = true;
        }
        return days;
    }

    private static boolean anyDay(boolean[] days) {
        for (boolean d : days) if (d) return true;
        return false;
    }

    /** Parses "H:MM"/"HH:MM" into {hour, minute}; null when malformed. */
    private static int[] parseTime(String s) {
        if (s == null) return null;
        s = s.trim();
        int c = s.indexOf(':');
        if (c <= 0) return null;
        try {
            int h = Integer.parseInt(s.substring(0, c));
            int m = Integer.parseInt(s.substring(c + 1).trim());
            if (h < 0 || h > 23 || m < 0 || m > 59) return null;
            return new int[]{h, m};
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** True when the alarm's "time" field parses as a valid HH:MM. */
    static boolean isValidTime(JSONObject a) {
        return parseTime(a.optString("time", "")) != null;
    }

    /**
     * Next local wall-clock occurrence strictly after {@code now}. Empty/absent
     * days means every day. Returns -1 when the time field is invalid.
     */
    static long nextTrigger(JSONObject a, long now) {
        int[] hm = parseTime(a.optString("time", ""));
        if (hm == null) return -1L;
        boolean[] days = parseDays(a.optJSONArray("days"));
        boolean everyday = !anyDay(days);
        Calendar cal = Calendar.getInstance();
        for (int add = 0; add < 8; add++) {
            cal.setTimeInMillis(now);
            cal.add(Calendar.DAY_OF_YEAR, add);
            cal.set(Calendar.HOUR_OF_DAY, hm[0]);
            cal.set(Calendar.MINUTE, hm[1]);
            cal.set(Calendar.SECOND, 0);
            cal.set(Calendar.MILLISECOND, 0);
            long t = cal.getTimeInMillis();
            if (t <= now) continue;
            if (everyday) return t;
            int idx = cal.get(Calendar.DAY_OF_WEEK) - 1; // Calendar.SUNDAY=1 -> 0
            if (days[idx]) return t;
        }
        return now + 24L * 60L * 60L * 1000L;
    }

    /** Arms the next occurrence of a repeating alarm (no-op when disabled/invalid). */
    static void schedule(Context c, JSONObject a) {
        String id = a.optString("id", "");
        if (id.isEmpty()) return;
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent fire = firePi(c, id);
        am.cancel(fire);
        if (!a.optBoolean("enabled", true)) {
            cancelNotification(c, id);
            return;
        }
        long at = nextTrigger(a, System.currentTimeMillis());
        if (at <= 0L) return;
        set(am, c, at, fire, true);
    }

    /** Clears everything native knows about one alarm (pending fire + snooze + notification). */
    static void reset(Context c, JSONObject a) {
        String id = a.optString("id", "");
        if (id.isEmpty()) return;
        reset(c, id);
    }

    static void reset(Context c, String id) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am != null) {
            am.cancel(firePi(c, id));
            am.cancel(snoozePi(c, id));
        }
        AlarmStore.clearSnooze(c, id);
        cancelNotification(c, id);
    }

    static void cancel(Context c, String id) {
        reset(c, id);
    }

    static void cancelAll(Context c) {
        JSONArray items = AlarmStore.load(c);
        for (int i = 0; i < items.length(); i++) {
            JSONObject o = items.optJSONObject(i);
            if (o != null) reset(c, o.optString("id", ""));
        }
        AlarmStore.clear(c);
    }

    /**
     * Re-arms every stored alarm + pending snooze after BOOT_COMPLETED /
     * MY_PACKAGE_REPLACED. Snoozes whose fire time already passed are dropped
     * (the daily occurrence stands on its own).
     */
    static void rescheduleAll(Context c) {
        JSONArray items = AlarmStore.load(c);
        for (int i = 0; i < items.length(); i++) {
            JSONObject o = items.optJSONObject(i);
            if (o != null) schedule(c, o);
        }
        long now = System.currentTimeMillis();
        Map<String, Long> sn = AlarmStore.snoozes(c);
        for (Map.Entry<String, Long> e : new HashMap<>(sn).entrySet()) {
            String id = e.getKey();
            long at = e.getValue();
            JSONObject alarm = AlarmStore.get(c, id);
            if (alarm == null || !alarm.optBoolean("enabled", true) || at <= now) {
                AlarmStore.clearSnooze(c, id);
                continue;
            }
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            if (am != null) set(am, c, at, snoozePi(c, id), false);
        }
    }

    /** Snoozes an alarm: one-shot fire at now + snoozeMin (default 5). */
    static void snooze(Context c, String id) {
        JSONObject a = AlarmStore.get(c, id);
        if (a == null) return;
        int min = a.optInt("snoozeMin", DEFAULT_SNOOZE_MIN);
        if (min < 1) min = DEFAULT_SNOOZE_MIN;
        long at = System.currentTimeMillis() + min * 60_000L;
        AlarmStore.putSnooze(c, id, at);
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am != null) set(am, c, at, snoozePi(c, id), false);
    }

    /**
     * @param clock true = user-visible alarm (setAlarmClock), false = one-shot
     *              snooze (setExactAndAllowWhileIdle). Inexact fallback when the
     *              exact-alarm permission is unavailable.
     */
    private static void set(AlarmManager am, Context c, long at, PendingIntent fire, boolean clock) {
        try {
            if (canScheduleExact(c)) {
                if (clock) {
                    PendingIntent show = PendingIntent.getActivity(c, RC_SHOW,
                            new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                            PI_FLAGS);
                    am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, show), fire);
                } else {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire);
                }
            } else {
                // No exact-alarm grant (API 31+): inexact but Doze-friendly, no crash.
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire);
            }
        } catch (SecurityException e) {
            // Permission revoked between the check and the call.
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire);
        }
    }

    /* ---------------------------------------------------------- intents */

    private static int rc(String id) {
        return id == null ? 0 : id.hashCode();
    }

    static int notifyId(String id) {
        return rc(id);
    }

    private static PendingIntent firePi(Context c, String id) {
        Intent i = new Intent(c, AlarmReceiver.class);
        i.setAction(ACTION_FIRE);
        i.putExtra(EXTRA_ID, id);
        return PendingIntent.getBroadcast(c, rc(id), i, PI_FLAGS);
    }

    private static PendingIntent snoozePi(Context c, String id) {
        Intent i = new Intent(c, AlarmReceiver.class);
        i.setAction(ACTION_FIRE_SNOOZE);
        i.putExtra(EXTRA_ID, id);
        return PendingIntent.getBroadcast(c, rc(id) ^ 0x5A5A, i, PI_FLAGS);
    }

    /* ------------------------------------------------------ notification */

    /**
     * High-importance channel so the full-screen intent can take over the lock
     * screen on API 29+ (where background activity starts are otherwise
     * blocked). Channel sound/vibration are OFF: the sound is played by
     * AlarmRingActivity from the web layer's clip, and vibration is driven by
     * the alarm's "vibrate" flag — a channel default would double both.
     * NotificationChannel is API 26+, so this is a no-op below that.
     */
    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Alarm",
                NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Ryza alarm");
        ch.setSound(null, null);
        ch.enableVibration(false);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ch);
    }

    /**
     * Background/process-dead path: a full-screen-intent notification is the
     * only sanctioned way to raise the ring over the lock screen on API 29+.
     * USE_FULL_SCREEN_INTENT (API 29+) is a normal permission; on API 34 it is
     * granted to CATEGORY_ALARM notifications like this one.
     */
    static void postRingNotification(Context c, JSONObject a) {
        String id = a.optString("id", "");
        if (id.isEmpty()) return;
        ensureChannel(c);

        Intent ring = new Intent(c, AlarmRingActivity.class);
        ring.setAction(ACTION_FIRE);
        ring.putExtra(EXTRA_ID, id);
        ring.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent full = PendingIntent.getActivity(c, rc(id) ^ 0x1234, ring, PI_FLAGS);

        PendingIntent snooze = PendingIntent.getBroadcast(c, rc(id) ^ 0x2222,
                new Intent(c, AlarmReceiver.class).setAction(ACTION_SNOOZE).putExtra(EXTRA_ID, id), PI_FLAGS);
        PendingIntent dismiss = PendingIntent.getBroadcast(c, rc(id) ^ 0x3333,
                new Intent(c, AlarmReceiver.class).setAction(ACTION_DISMISS).putExtra(EXTRA_ID, id), PI_FLAGS);

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b = new Notification.Builder(c, CHANNEL_ID);
        } else {
            b = new Notification.Builder(c);
        }
        b.setSmallIcon(appIcon(c))
                .setContentTitle(a.optString("time", "")) // locale-neutral (a clock string)
                .setContentIntent(full)
                .setFullScreenIntent(full, true)
                .setCategory(Notification.CATEGORY_ALARM)
                .setOngoing(true)
                .setAutoCancel(false)
                .setShowWhen(false)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setPriority(Notification.PRIORITY_HIGH);
        // The only native user-visible strings (web owns the 7 UI locales).
        b.addAction(new Notification.Action.Builder(
                Icon.createWithResource(c, appIcon(c)), "Snooze", snooze).build());
        b.addAction(new Notification.Action.Builder(
                Icon.createWithResource(c, appIcon(c)), "Dismiss", dismiss).build());

        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(notifyId(id), b.build());
    }

    /**
     * The app's own launcher icon, resolved at runtime from ApplicationInfo.
     * The Gradle-less build runs aapt2 without --java, so there is NO generated
     * R class to reference here; android.R.drawable is only the fallback.
     */
    private static int appIcon(Context c) {
        int id = c.getApplicationInfo().icon;
        return id != 0 ? id : android.R.drawable.ic_lock_idle_alarm;
    }

    static void cancelNotification(Context c, String id) {
        if (id == null) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(notifyId(id));
    }
}
