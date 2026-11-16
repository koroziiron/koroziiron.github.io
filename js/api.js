// ============================================================
// СЛОЙ РАБОТЫ С СЕРВЕРОМ (наш API). Прямого доступа к базе у сайта нет.
// Сигнатуры функций сохранены, чтобы остальной код сайта не менялся.
// ============================================================
import { request, setToken, clearApiToken, getToken } from './server-api.js';

// Ошибка для мест, где UI показывает текст правила (раньше — сообщение триггера БД, code 'P0001')
function ruleError(r) {
  if (r.status === 0 || r.status >= 500 || r.status === 404 || !r.data) return { code: 'server', message: 'Сервер недоступен' };
  return { code: 'P0001', message: r.data.message || 'Ошибка', status: r.status };
}

// Ошибка-строка для профиля/команд: известный код либо готовый русский текст
function codeError(r, map = {}) {
  if (r.status === 0 || r.status >= 500) return 'server';
  const e = r.data?.error;
  if (e && map[e]) return map[e];
  if (r.status === 404) return 'not_found';
  if (r.status === 422 && e === 'validation') return 'invalid';
  return r.data?.message || 'server';
}

const myId = () => { try { return JSON.parse(localStorage.getItem('kp_member') || 'null')?.id; } catch { return null; } };

// ------------------------------------------------------------
// Вход / сессия
// ------------------------------------------------------------
export async function login(rawKey) {
  const r = await request('/auth/login', { method: 'POST', body: { key: rawKey }, auth: false });
  if (r.status === 0 || r.status >= 500) return { error: 'server' };
  if (r.status === 401) return { error: 'invalid_key' };
  if (r.status === 429) return { error: 'locked', message: r.data?.message };
  if (r.status !== 200 || !r.data?.token) return { error: 'server' };
  setToken(r.data.token, r.data.expires_at);
  const { session_version, ...member } = r.data.member;
  return { member };
}

// Актуальные данные участника. member: null — сессии нет или она закончилась.
export async function getSession() {
  if (!getToken()) return { member: null };
  const r = await request('/auth/me');
  if (r.status === 401) return { member: null };
  if (r.status !== 200) return { error: 'server' };
  return { member: r.data };
}

export async function ping() {
  const r = await request('/health', { auth: false, timeoutMs: 8000 });
  return r.status === 200;
}

// ------------------------------------------------------------
// Профиль
// ------------------------------------------------------------
export async function updateNickname(memberId, nickname) {
  const r = await request('/me', { method: 'PATCH', body: { nickname: String(nickname || '').trim() } });
  if (r.status !== 200) return { error: codeError(r, { taken: 'taken' }) };
  return { member: r.data };
}

export async function updateDiscordName(memberId, rawName) {
  const name = String(rawName || '').trim().replace(/^@+/, '').toLowerCase();
  const r = await request('/me', { method: 'PATCH', body: { discord_name: name || null } });
  if (r.status !== 200) return { error: codeError(r) };
  return { member: r.data };
}

// Смена пароля: нужен текущий. Сервер гасит все остальные сессии и выдаёт новую для этого устройства.
export async function changePassword(memberId, currentKey, newKey) {
  const r = await request('/me/password', { method: 'POST', body: { current: currentKey, new: newKey } });
  if (r.status !== 200 || !r.data?.token) return { error: codeError(r) };
  setToken(r.data.token, r.data.expires_at);
  return { success: true };
}

// ------------------------------------------------------------
// Справочники
// ------------------------------------------------------------
export async function getClasses() {
  const r = await request('/classes');
  if (r.status !== 200) return { error: r };
  return { classes: r.data };
}

export async function getRaidTypes() {
  const r = await request('/raid-types');
  if (r.status !== 200) return { error: r };
  return { raidTypes: r.data };
}

// ------------------------------------------------------------
// Персонажи
// ------------------------------------------------------------
export async function getCharacters() {
  const r = await request('/me/characters');
  if (r.status !== 200) return { error: r };
  return { characters: r.data };
}

// Пакет изменений: удаление → переименование → добавление (ГС/БС новых подтянет сервер с оружейки)
export async function saveChanges(memberId, { inserted, updated, deleted }) {
  const errors = [];
  for (const id of deleted) {
    const r = await request('/me/characters/' + id, { method: 'DELETE' });
    if (r.status !== 200) errors.push({ op: 'delete', id, error: ruleError(r) });
  }
  for (const ch of updated) {
    if (!('name' in ch)) continue;
    const name = String(ch.name ?? '').trim();
    if (!name) { errors.push({ op: 'update', id: ch.id, error: new Error('Пустое имя персонажа') }); continue; }
    const r = await request('/me/characters/' + ch.id, { method: 'PATCH', body: { name } });
    if (r.status !== 200) errors.push({ op: 'update', id: ch.id, error: ruleError(r) });
  }
  for (const ch of [...inserted].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))) {
    const r = await request('/me/characters', { method: 'POST', body: { name: String(ch.name).trim(), class_id: ch.class_id } });
    if (r.status !== 201) errors.push({ op: 'insert', error: ruleError(r) });
  }
  if (errors.length > 0) return { error: errors };
  return { success: true };
}

export async function setGoldCoin(characterId, value) {
  const r = await request('/me/characters/' + characterId, { method: 'PATCH', body: { gold_coin_active: !!value } });
  return r.status === 200 ? { success: true } : { error: ruleError(r) };
}

export async function saveCharacterOrder(ids) {
  const r = await request('/me/characters/order', { method: 'PUT', body: { ids } });
  return r.status === 200 ? { success: true } : { error: ruleError(r) };
}

// ------------------------------------------------------------
// Отметки «пройден» у персонажей
// ------------------------------------------------------------
export async function getProgress() {
  const r = await request('/me/progress');
  if (r.status !== 200) return { error: r };
  return { progress: r.data };
}

export async function setProgress(characterId, raidKey, completed) {
  const r = await request('/me/progress', { method: 'PUT', body: { character_id: characterId, raid_key: raidKey, completed } });
  return r.status === 200 ? { success: true } : { error: ruleError(r) };
}

export async function clearProgress() {
  const r = await request('/me/progress/clear', { method: 'POST' });
  return r.status === 200 ? { success: true } : { error: ruleError(r) };
}

// ------------------------------------------------------------
// Рейды и записи
// ------------------------------------------------------------
export async function getRaidsInRange(teamIds = []) {
  if (!teamIds.length) return { raids: [] };
  const r = await request('/raids');
  if (r.status !== 200) return { error: r };
  const allowed = new Set(teamIds.map(String));
  return { raids: (r.data || []).filter(x => allowed.has(String(x.team_id))) };
}

export async function createRaid({ raid_type_id, weekday, start_time, team_id, min_combat_power = 0 }) {
  const r = await request('/raids', { method: 'POST', body: { raid_type_id, weekday, start_time, team_id, min_combat_power: Math.max(0, Math.floor(Number(min_combat_power) || 0)) } });
  if (r.status !== 201) return { error: ruleError(r) };
  return { raid: r.data };
}

export async function updateRaid(raidId, { weekday, start_time, min_combat_power }) {
  const body = { weekday };
  if (start_time) body.start_time = start_time;
  if (min_combat_power !== undefined) body.min_combat_power = Math.max(0, Math.floor(Number(min_combat_power) || 0));
  const r = await request('/raids/' + raidId, { method: 'PATCH', body });
  if (r.status !== 200) return { error: ruleError(r) };
  return { raid: r.data };
}

export async function deleteRaid(raidId) {
  const r = await request('/raids/' + raidId, { method: 'DELETE' });
  return r.status === 200 ? { success: true } : { error: ruleError(r) };
}

// Отметка «рейд пройден» (status: 'done' | 'open'). Записываться на пройденный рейд по-прежнему можно.
export async function setRaidStatus(raidId, status) {
  const r = await request('/raids/' + raidId + '/status', { method: 'PUT', body: { status } });
  return r.status === 200 ? { success: true } : { error: ruleError(r) };
}

// Лидер: снять отметки «пройден» у всех рейдов своих команд
export async function resetRaidsDone(teamIds) {
  if (!teamIds.length) return { success: true };
  const r = await request('/raids/reset-done', { method: 'POST', body: {} });
  return r.status === 200 ? { success: true } : { error: ruleError(r) };
}

// Роль и владельца записи определяет сервер (параметры member_id/role игнорируются)
export async function signup({ raid_id, character_id }) {
  const r = await request('/raids/' + raid_id + '/signups', { method: 'POST', body: { character_id } });
  if (r.status !== 201) return { error: ruleError(r) };
  return { signup: r.data };
}

export async function unsign(signupId) {
  const r = await request('/signups/' + signupId, { method: 'DELETE' });
  return r.status === 200 ? { success: true } : { error: ruleError(r) };
}

// ------------------------------------------------------------
// Команды (КП)
// ------------------------------------------------------------
export async function getMyTeams() {
  const r = await request('/teams');
  if (r.status !== 200) return { error: r };
  return { teams: r.data };
}

export async function getTeamDetails(teamId) {
  const r = await request('/teams/' + teamId);
  if (r.status !== 200) return { error: r };
  return { members: r.data.members };
}

export async function createTeam(memberId, name) {
  const r = await request('/teams', { method: 'POST', body: { name: String(name || '').trim() } });
  if (r.status !== 201) return { error: codeError(r, { duplicate: 'name_taken' }) };
  return { team: r.data };
}

export async function joinTeam(memberId, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { error: 'invalid' };
  const r = await request('/teams/join', { method: 'POST', body: { code } });
  if (r.status !== 200) return { error: codeError(r, { already: 'already' }) };
  return { team: r.data };
}

// Выход из команды (себя) или изгнание (лидером)
export async function removeTeamMember(teamId, memberId) {
  const r = memberId === myId()
    ? await request('/teams/' + teamId + '/leave', { method: 'POST' })
    : await request('/teams/' + teamId + '/members/' + memberId, { method: 'DELETE' });
  return r.status === 200 ? { success: true } : { error: codeError(r) };
}

export async function setInviteCode(teamId, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  const r = await request('/teams/' + teamId + '/invite-code', { method: 'PUT', body: { code } });
  if (r.status !== 200) return { error: codeError(r, { code_taken: 'code_taken', validation: 'invalid' }) };
  return { code: r.data.code };
}

// Роспуск: сервер сам проверяет пароль лидера
export async function disbandTeam(teamId, password) {
  const r = await request('/teams/' + teamId + '/disband', { method: 'POST', body: { password } });
  return r.status === 200 ? { success: true } : { error: codeError(r) };
}

// ------------------------------------------------------------
// Краткий профиль участника (окно по клику на игрока в расписании)
// ------------------------------------------------------------
export async function getMemberProfile(memberId) {
  const r = await request('/members/' + memberId + '/profile');
  if (r.status !== 200) return { error: r };
  return r.data;
}

export { clearApiToken };
