// ============================================================
// КЛИЕНТ НАШЕГО API (пока только для обновления ГС/БС)
// Токен получаем при входе по ключу и храним в localStorage.
// ============================================================
import { API_BASE } from '../supabase-config.js';

const TOKEN_KEY = 'kp_api_token';

export const apiEnabled = () => !!API_BASE;

function getToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (t && t.token && new Date(t.expires_at) > new Date()) return t.token;
  } catch {}
  return null;
}
export const hasApiToken = () => !!getToken();

export function clearApiToken() {
  const token = getToken();
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  if (token && API_BASE) {
    fetch(API_BASE + '/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
  }
}

async function request(path, { method = 'GET', body, token, timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(API_BASE + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let data = null;
    try { data = await resp.json(); } catch {}
    return { status: resp.status, data };
  } catch (e) {
    return { status: 0, data: null };
  } finally {
    clearTimeout(timer);
  }
}

// Вход по ключу (тот же ключ, что на сайте). Ошибки не блокируют вход на сайт.
export async function apiLogin(key) {
  if (!API_BASE) return false;
  const r = await request('/auth/login', { method: 'POST', body: { key } });
  if (r.status === 200 && r.data?.token) {
    try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: r.data.token, expires_at: r.data.expires_at })); } catch {}
    return true;
  }
  console.warn('API login failed:', r.status, r.data?.message || '');
  return false;
}

// Просим сервер обновить ГС/БС с оружейки; возвращает актуальный список персонажей из БД сервера
export async function apiRefreshStats() {
  const token = getToken();
  if (!token) return { error: 'no_token' };
  const r = await request('/me/characters/refresh', { method: 'POST', token, timeoutMs: 60000 });
  if (r.status === 401) { try { localStorage.removeItem(TOKEN_KEY); } catch {} return { error: 'unauthorized' }; }
  if (r.status === 429) return { error: 'rate_limited' };
  if (r.status !== 200 || !r.data) return { error: 'server' };
  return { result: r.data.result, characters: r.data.characters || [] };
}
