package com.ryza.chat;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Thin WebView shell. No androidx — the whole app is the bundled web build
 * served from AssetServer on 127.0.0.1 (Spine cannot load from file://).
 */
public class MainActivity extends Activity {
    /** requestPermissions() callback code for the mic (API 23+). */
    private static final int REQ_RECORD_AUDIO = 9002;

    private AssetServer server;
    private WebView web;
    /** Set while a page getUserMedia(audio) request waits on the runtime prompt. */
    private PermissionRequest pendingAudioRequest;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        server = new AssetServer(getAssets(), 8765);
        server.start();

        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        web.setWebChromeClient(new WebChromeClient() {
            /**
             * The default WebChromeClient denies getUserMedia, which blocked the
             * web layer's speech input. Grant ONLY audio capture, and only when
             * the RECORD_AUDIO runtime permission (API 23+) is already held;
             * otherwise ask for it and answer the page in
             * onRequestPermissionsResult. Every other resource is denied on
             * purpose — the page needs no camera/screen capture.
             */
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                boolean wantsAudio = false;
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) wantsAudio = true;
                }
                if (!wantsAudio) {
                    request.deny();
                    return;
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                        == PackageManager.PERMISSION_GRANTED) {
                    // Grant just the mic even if the page asked for more.
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    return;
                }
                if (pendingAudioRequest != null) pendingAudioRequest.deny();
                pendingAudioRequest = request;
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_RECORD_AUDIO);
            }
        });
        web.setWebViewClient(new WebViewClient());

        // Alarm scheduler bridge (see RyzaAlarm for the documented JS contract).
        RyzaAlarm.attach(this, web);

        web.loadUrl("http://127.0.0.1:8765/");
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (code == REQ_RECORD_AUDIO) {
            PermissionRequest request = pendingAudioRequest;
            pendingAudioRequest = null;
            if (request == null) return;
            boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            if (granted) request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            else request.deny();
            return;
        }
        super.onRequestPermissionsResult(code, permissions, results);
    }

    @Override public void onPause()  {
        RyzaAlarm.setForeground(false);
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override public void onResume() {
        super.onResume();
        RyzaAlarm.setForeground(true);
        if (web != null) web.onResume();
    }

    @Override
    public void onBackPressed() {
        if (web != null) {
            if (web.canGoBack()) { web.goBack(); return; }
            /* Every menu in this app is a DOM overlay on one page — side menu,
               sheets, modals, full-screen views — none of them push a URL, so
               canGoBack() is always false and the back key used to exit the app
               instead of closing the open menu. Ask the page first: if a layer
               consumed the press it returns true and we stay; only then exit.
               Must run on the UI thread, which post() guarantees. */
            web.post(() -> web.evaluateJavascript(
                "(window.RyzaShell && RyzaShell.handleBack) ? RyzaShell.handleBack() : false",
                value -> {
                    boolean handled = value != null
                            && !value.equals("false") && !value.equals("null");
                    if (!handled) MainActivity.super.onBackPressed();
                }));
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        RyzaAlarm.detach();
        if (server != null) server.stopServer();
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
