/* ============================================================
   KALKA BUSINESS HUB — boot
   ============================================================ */
'use strict';

(async function boot() {
  // drop the protected grant whenever the app leaves the foreground
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      API.clearGrant();
      if (App.route === 'history') { /* next render will show the lock */ }
    }
  });
  window.addEventListener('pagehide', () => API.clearGrant());

  if (API.token) {
    try {
      const d = await API.get('/api/me');
      if (d.user) {
        App.user = d.user;
        App.security = d.security;
        App.route = 'dashboard';
      } else {
        API.clear();
      }
    } catch (e) {
      API.clear();
    }
  }
  render();
  setInterval(() => { if (App.user) refreshBadge(); }, 45000);
})();
