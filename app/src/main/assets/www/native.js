/* ============================================================
   KALKA BUSINESS HUB — native bridge
   The Android shell injects window.KalkaNative. On the web/desktop the
   same object is provided by a small shim so the app runs unchanged.
   Biometric verification happens in the OS (Android BiometricPrompt) and
   is reported back here — the JS never pretends it succeeded.
   ============================================================ */
'use strict';

const Native = {
  available() {
    return !!(window.KalkaNative && typeof window.KalkaNative.authenticate === 'function');
  },

  /**
   * Ask Android's BiometricPrompt. The bridge returns nothing: the OS shows the
   * prompt and calls window.__kalkaBiometricResult(ok) when the user is done.
   * We resolve only on that callback, never optimistically.
   */
  authenticate(title, subtitle) {
    return new Promise((resolve) => {
      if (!Native.available()) { resolve({ ok: false, reason: 'unavailable' }); return; }
      let done = false;
      const timer = setTimeout(() => {
        if (!done) { done = true; window.__kalkaBiometricResult = null; resolve({ ok: false, reason: 'timeout' }); }
      }, 90000);

      window.__kalkaBiometricResult = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.__kalkaBiometricResult = null;
        resolve(ok ? { ok: true } : { ok: false, reason: 'failed' });
      };

      try {
        window.KalkaNative.authenticate(
          title || 'PRIVATE PROJECT HISTORY',
          subtitle || 'Authenticate to access your private business records.');
      } catch (err) {
        done = true;
        clearTimeout(timer);
        window.__kalkaBiometricResult = null;
        resolve({ ok: false, reason: String(err) });
      }
    });
  },

  canAuthenticate() {
    if (!Native.available()) return false;
    try {
      const v = window.KalkaNative.canAuthenticate();
      return v === true || v === 'true';
    } catch (e) { return false; }
  },

  platform() { return window.KalkaNative ? 'android' : 'web'; },

  vibrate(ms) { if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) {} } },
};

/* On the web build, provide an honest shim: biometric is not available,
   so the UI says so instead of faking a fingerprint animation. */
if (!window.KalkaNative) {
  window.KalkaNative = {
    canAuthenticate: () => false,
    authenticate: () => JSON.stringify({ ok: false, reason: 'not-supported-on-this-platform' }),
  };
}
