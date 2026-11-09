/* ============================================================
   KALKA BUSINESS HUB — API client for the on-device server
   All calls carry the session token; Project History calls also carry the
   short-lived biometric grant. Nothing here decides permissions.
   ============================================================ */
'use strict';

const API = {
  base: '',
  token: localStorage.getItem('kbh.token') || '',
  grant: '',
  grantUntil: 0,

  headers(extra) {
    const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
    if (API.token) h['X-Kalka-Token'] = API.token;
    if (API.grant && Date.now() < API.grantUntil) h['X-History-Grant'] = API.grant;
    return h;
  },

  async request(method, path, body, isForm) {
    const opts = { method, headers: API.headers(isForm ? { 'Content-Type': 'application/json' } : null) };
    if (body !== undefined) opts.body = JSON.stringify(body);
    let res;
    try {
      res = await fetch(API.base + path, opts);
    } catch (e) {
      throw Object.assign(new Error('Cannot reach the app server'), { code: 'network' });
    }
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      if (res.status === 401 && API.token) { API.clear(); }
      if (data.code === 'history_locked') { API.grant = ''; }
      throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, code: data.code });
    }
    return data;
  },

  get(p) { return API.request('GET', p); },
  post(p, b) { return API.request('POST', p, b || {}); },
  put(p, b) { return API.request('PUT', p, b || {}); },
  del(p) { return API.request('DELETE', p); },

  setToken(t) {
    API.token = t || '';
    if (t) localStorage.setItem('kbh.token', t); else localStorage.removeItem('kbh.token');
  },
  setGrant(g, minutes) {
    API.grant = g;
    API.grantUntil = Date.now() + minutes * 60 * 1000;
  },
  clearGrant() { API.grant = ''; API.grantUntil = 0; },
  grantValid() { return !!API.grant && Date.now() < API.grantUntil; },
  clear() {
    API.token = ''; API.grant = ''; API.grantUntil = 0;
    localStorage.removeItem('kbh.token');
  },
};

/* media helper: fetch a protected file and return an object URL */
async function protectedUrl(path) {
  const res = await fetch(API.base + path, { headers: API.headers() });
  if (!res.ok) throw new Error('Could not load image');
  return URL.createObjectURL(await res.blob());
}
