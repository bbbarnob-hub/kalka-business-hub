package com.kalka.hub;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebViewAssetLoader;

import com.chaquo.python.PyObject;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;

import java.io.File;
import java.util.concurrent.Executor;

/**
 * KALKA BUSINESS HUB — Android shell.
 *
 * The business backend is Python and runs *on the phone* (Chaquopy), listening on
 * 127.0.0.1 only. The UI is the same web app used on desktop, served to the WebView
 * through the secure asset loader so no file:// access is exposed.
 *
 * Fingerprint authentication is done by Android itself (BiometricPrompt) and the
 * result is handed to JavaScript through {@link Bridge}. Nothing in the UI can
 * unlock protected history without a real OS-level authentication.
 */
public class MainActivity extends AppCompatActivity {

    private static final int PORT = 8765;
    private WebView webView;
    private Executor executor;
    private BiometricPrompt biometricPrompt;
    private BiometricPrompt.PromptInfo promptInfo;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (!Python.isStarted()) {
            Python.start(new AndroidPlatform(this));
        }
        startBackend();

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSupportZoom(false);
        s.setTextZoom(100);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String host = request.getUrl().getHost();
                // API calls go to the local Python server; everything else is app assets.
                if ("127.0.0.1".equals(host) || "localhost".equals(host)) {
                    return null;
                }
                return loader.shouldInterceptRequest(request.getUrl());
            }
        });

        webView.addJavascriptInterface(new Bridge(), "KalkaNative");
        webView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html");

        executor = ContextCompat.getMainExecutor(this);
        buildBiometricPrompt();
        askNotificationPermission();
    }

    /** Boot the on-device Python backend in the background. */
    private void startBackend() {
        new Thread(() -> {
            try {
                Python py = Python.getInstance();
                File dataDir = new File(getFilesDir(), "kalka");
                //noinspection ResultOfMethodCallIgnored
                dataDir.mkdirs();
                PyObject module = py.getModule("server");
                module.callAttr("start_server", dataDir.getAbsolutePath(), PORT);
            } catch (Throwable t) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this,
                        "Backend failed to start: " + t.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private void buildBiometricPrompt() {
        biometricPrompt = new BiometricPrompt(this, executor,
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                        // Real OS-level success — tell the page.
                        runOnUiThread(() -> webView.evaluateJavascript(
                                "window.__kalkaBiometricResult && window.__kalkaBiometricResult(true)", null));
                    }

                    @Override
                    public void onAuthenticationError(int code, @NonNull CharSequence msg) {
                        runOnUiThread(() -> webView.evaluateJavascript(
                                "window.__kalkaBiometricResult && window.__kalkaBiometricResult(false)", null));
                    }

                    @Override
                    public void onAuthenticationFailed() {
                        // a single bad attempt: keep the prompt open, do not resolve
                    }
                });

        promptInfo = new BiometricPrompt.PromptInfo.Builder()
                .setTitle("PRIVATE PROJECT HISTORY")
                .setSubtitle("Authenticate to access your private business records.")
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG
                        | BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                .setNegativeButtonText("Cancel")
                .build();
    }

    private boolean hasBiometric() {
        int can = BiometricManager.from(this)
                .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG
                        | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
        return can == BiometricManager.BIOMETRIC_SUCCESS;
    }

    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this,
                        new String[]{Manifest.permission.POST_NOTIFICATIONS}, 101);
            }
        }
    }

    /** Exposed to JavaScript as window.KalkaNative */
    public class Bridge {
        @android.webkit.JavascriptInterface
        public boolean canAuthenticate() {
            return hasBiometric();
        }

        /**
         * The page calls this and waits for window.__kalkaBiometricResult(ok).
         * The OS prompt is the only thing that can produce a true result.
         */
        @android.webkit.JavascriptInterface
        public void authenticate(String title, String subtitle) {
            runOnUiThread(() -> {
                if (!hasBiometric()) {
                    webView.evaluateJavascript(
                            "window.__kalkaBiometricResult && window.__kalkaBiometricResult(false)", null);
                    return;
                }
                BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                        .setTitle(title == null ? "PRIVATE PROJECT HISTORY" : title)
                        .setSubtitle(subtitle == null ? "Authenticate to access your private business records." : subtitle)
                        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG
                                | BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                        .setNegativeButtonText("Cancel")
                        .build();
                biometricPrompt.authenticate(info);
            });
        }

        @android.webkit.JavascriptInterface
        public int backendPort() {
            return PORT;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
