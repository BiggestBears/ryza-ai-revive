package com.ryza.chat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import org.json.JSONObject;

/**
 * Alarm delivery. Every branch is explicit-intent only (the manifest sets
 * android:exported="false"), so nothing outside the app can ring a customer's
 * alarm: AlarmManager delivers the fire PendingIntent and the notification
 * buttons deliver snooze/dismiss.
 *
 * Actions:
 *   ALARM_FIRE        - a repeating occurrence fired; re-arm the next one.
 *   ALARM_FIRE_SNOOZE - a snooze one-shot fired; the daily schedule is untouched.
 *   ALARM_SNOOZE      - user tapped Snooze (ring screen or notification).
 *   ALARM_DISMISS     - user tapped Dismiss.
 *
 * Foreground vs background: when MainActivity is resumed the native side does
 * NOT raise its own ring screen — it hands the alarm to the page through
 * RyzaAlarm.deliverFire() (see the bridge contract). Otherwise it posts the
 * full-screen-intent notification; below API 29 it also starts the ring screen
 * directly because background activity starts were still allowed then.
 */
public class AlarmReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        String id = intent.getStringExtra(AlarmScheduler.EXTRA_ID);
        if (id == null || id.isEmpty()) return;

        if (AlarmScheduler.ACTION_DISMISS.equals(action)) {
            AlarmScheduler.cancelNotification(context, id);
            AlarmStore.clearSnooze(context, id);
            AlarmRingActivity.finishIfShowing();
            return;
        }

        if (AlarmScheduler.ACTION_SNOOZE.equals(action)) {
            AlarmScheduler.cancelNotification(context, id);
            AlarmScheduler.snooze(context, id);
            AlarmRingActivity.finishIfShowing();
            return;
        }

        boolean snoozeFire = AlarmScheduler.ACTION_FIRE_SNOOZE.equals(action);
        if (!AlarmScheduler.ACTION_FIRE.equals(action) && !snoozeFire) return;

        JSONObject alarm = AlarmStore.get(context, id);
        if (alarm == null || !alarm.optBoolean("enabled", true)) {
            AlarmStore.clearSnooze(context, id);
            return;
        }
        if (snoozeFire) {
            AlarmStore.clearSnooze(context, id);
        } else {
            // Repeating in the web model: arm tomorrow/next selected day now.
            AlarmScheduler.schedule(context, alarm);
        }

        if (RyzaAlarm.isForeground() && RyzaAlarm.deliverFire(context, alarm)) return;

        AlarmScheduler.postRingNotification(context, alarm);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // API < 29: background activity starts are allowed, so raise the
            // ring screen directly as well as via the notification.
            try {
                Intent ring = new Intent(context, AlarmRingActivity.class);
                ring.setAction(action);
                ring.putExtra(AlarmScheduler.EXTRA_ID, id);
                ring.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(ring);
            } catch (Exception ignored) {}
        }
    }
}
