package com.ryza.chat;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;

import java.lang.ref.WeakReference;

/**
 * The ringing screen. Shown over the lock screen by the full-screen intent
 * (background) or started directly below API 29; when the app is in the
 * foreground the web layer's own ring overlay is used instead and this screen
 * is not started.
 *
 * Lock-screen flags: setShowWhenLocked/setTurnScreenOn are API 27+; on older
 * systems the equivalent window flags are used. Both paths are needed because
 * minSdk is 24.
 *
 * Audio: the web layer owns the clips and passes an asset-relative path in the
 * alarm's "audio" field. This screen starts a second AssetServer (127.0.0.1:8766,
 * distinct from MainActivity's 8765) when the process was dead, so MediaPlayer
 * can stream it; an absolute http(s) URL is played directly. No audio binary is
 * bundled in android/ — an empty "audio" simply vibrates.
 *
 * The only native user-visible strings are the two button labels below; the
 * page owns the 7 UI locales, so these are deliberately minimal and
 * English-neutral.
 */
public class AlarmRingActivity extends Activity {
    private static final int RING_PORT = 8766;
    private static WeakReference<AlarmRingActivity> sShowing;

    private String alarmId;
    private LinearLayout root;
    private MediaPlayer player;
    private Vibrator vibrator;
    private AssetServer server;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }

        alarmId = getIntent() == null ? null : getIntent().getStringExtra(AlarmScheduler.EXTRA_ID);
        JSONObject alarm = alarmId == null ? null : AlarmStore.get(this, alarmId);
        if (alarm == null) {
            finish(); // stale intent (alarm deleted while the notification sat there)
            return;
        }
        setup(alarm);
        sShowing = new WeakReference<>(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String next = intent == null ? null : intent.getStringExtra(AlarmScheduler.EXTRA_ID);
        if (next == null || next.equals(alarmId)) return;
        AlarmRingActivity previous = sShowing == null ? null : sShowing.get();
        if (previous != null && previous != this) previous.finish();
        alarmId = next;
        JSONObject alarm = AlarmStore.get(this, alarmId);
        if (alarm == null) { finish(); return; }
        stopRing();
        setup(alarm);
    }

    private void setup(JSONObject alarm) {
        String time = alarm.optString("time", "");
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(Color.parseColor("#101014"));

        TextView clock = new TextView(this);
        clock.setText(time);
        clock.setTextColor(Color.WHITE);
        clock.setTextSize(64f);
        clock.setGravity(Gravity.CENTER);
        root.addView(clock, matchWrap());

        Button dismiss = new Button(this);
        dismiss.setText("Dismiss");
        dismiss.setOnClickListener(v -> userDismiss());
        root.addView(dismiss, matchWrap());

        Button snooze = new Button(this);
        snooze.setText("Snooze");
        snooze.setOnClickListener(v -> userSnooze());
        root.addView(snooze, matchWrap());

        setContentView(root);
        startRing(alarm);
    }

    private static LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private void userDismiss() {
        AlarmScheduler.cancelNotification(this, alarmId);
        AlarmStore.clearSnooze(this, alarmId);
        finish();
    }

    private void userSnooze() {
        AlarmScheduler.cancelNotification(this, alarmId);
        AlarmScheduler.snooze(this, alarmId);
        finish();
    }

    /** Back must not silently dismiss an alarm; the buttons are deliberate. */
    @Override
    public void onBackPressed() {
        // consumed
    }

    /* -------------------------------------------------------------- ringing */

    private void startRing(JSONObject alarm) {
        String path = alarm.optString("audio", "");
        if (!path.isEmpty()) {
            try {
                player = new MediaPlayer();
                player.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build());
                player.setDataSource(resolveAudio(path));
                player.setLooping(true);
                float vol = (float) Math.max(0.0, Math.min(1.0, alarm.optDouble("volume", 1.0)));
                player.setVolume(vol, vol);
                player.setOnPreparedListener(MediaPlayer::start);
                player.prepareAsync();
            } catch (Exception e) {
                releasePlayer();
            }
        }
        if (alarm.optBoolean("vibrate", true)) {
            vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            long[] pattern = {0, 600, 600};
            if (vibrator != null && vibrator.hasVibrator()) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
                } else {
                    vibrator.vibrate(pattern, 0);
                }
            }
        }
    }

    /**
     * Asset-relative paths are served over a local AssetServer started here so
     * this works when the process was killed; absolute URLs play as-is.
     */
    private String resolveAudio(String path) {
        if (path.startsWith("http://") || path.startsWith("https://")) return path;
        while (path.startsWith("/")) path = path.substring(1);
        if (server == null) {
            server = new AssetServer(getAssets(), RING_PORT);
            server.start();
        }
        return "http://127.0.0.1:" + RING_PORT + "/" + path;
    }

    private void stopRing() {
        releasePlayer();
        if (vibrator != null) {
            vibrator.cancel();
            vibrator = null;
        }
    }

    private void releasePlayer() {
        if (player != null) {
            try { player.stop(); } catch (Exception ignored) {}
            try { player.release(); } catch (Exception ignored) {}
            player = null;
        }
    }

    @Override
    protected void onDestroy() {
        stopRing();
        if (server != null) {
            server.stopServer();
            server = null;
        }
        if (sShowing != null && sShowing.get() == this) sShowing = null;
        super.onDestroy();
    }

    /** Called by AlarmReceiver so the snooze/dismiss notification actions also close the screen. */
    static void finishIfShowing() {
        AlarmRingActivity a = sShowing == null ? null : sShowing.get();
        if (a == null) return;
        a.runOnUiThread(() -> {
            if (!a.isFinishing()) a.finish();
        });
    }
}
