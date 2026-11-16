// ============================================================
// ЯДРО КЛИЕНТА НАШЕГО API
// Токен хранится в localStorage. Если сервер отвечает 401 (сессия закончилась,
// сменили пароль на другом устройстве), вызывается обработчик из app.js — выход.
// ============================================================
import { API_BASE } from './config.js';

const TOKEN_KEY = 'kp_api_token';
let onUnauthorized = null;

export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export function getToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (t && t.token) return t.token;   // срок жизни решает сервер (скользящий)
  } catch {}
  return null;
}
export function setToken(token, expires_at) {
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expires_at })); } catch {}
}
export function clearApiToken() {
  const token = getToken();
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  if (token) {
    fetch(API_BASE + '/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
  }
}

// Универсальный запрос. Возвращает { status, data }; status 0 — сервер недоступен.
export async function request(path, { method = 'GET', body, auth = true, timeoutMs = 15000 } = {}) {
  const token = auth ? getToken() : null;
  if (auth && !token) return { status: 401, data: { error: 'unauthorized', message: 'Требуется вход' }, noToken: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(API_BASE + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    let data = null;
    try { data = await resp.json(); } catch {}
    if (resp.status === 401 && auth && onUnauthorized) onUnauthorized();
    return { status: resp.status, data };
  } catch {
    return { status: 0, data: null };
  } finally {
    clearTimeout(timer);
  }
}

// Просим сервер обновить ГС/БС с оружейки; возвращает актуальный список персонажей
export async function apiRefreshStats() {
  const r = await request('/me/characters/refresh', { method: 'POST', timeoutMs: 60000 });
  if (r.noToken) return { error: 'no_token' };
  if (r.status === 401) return { error: 'unauthorized' };
  if (r.status === 429) return { error: 'rate_limited' };
  if (r.status !== 200 || !r.data) return { error: 'server' };
  return { result: r.data.result, characters: r.data.characters || [] };
}
