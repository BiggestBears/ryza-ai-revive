package com.ryza.chat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Re-arms stored alarms after a reboot or an app update: AlarmManager forgets
 * every pending alarm when the device restarts, so the persisted list from
 * AlarmStore must be pushed back.
 *
 * RECEIVE_BOOT_COMPLETED (API 1+) is the permission that allows BOOT_COMPLETED
 * to be delivered. android:exported="false" is correct here — BOOT_COMPLETED
 * and MY_PACKAGE_REPLACED are protected broadcasts only the system can send.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            AlarmScheduler.rescheduleAll(context);
        }
    }
}
