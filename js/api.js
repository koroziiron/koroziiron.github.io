// ============================================================
// СЛОЙ РАБОТЫ С SUPABASE
// ============================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY, ACCESS_KEY_SALT } from '../supabase-config.js';
import { toNumeric, toInteger } from './stats.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ------------------------------------------------------------
// Хеширование ключа
// ------------------------------------------------------------
export async function hashKey(rawKey) {
  const str = ACCESS_KEY_SALT + rawKey;
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ------------------------------------------------------------
// Логин по ключу
// Возвращает { member } или { error }
// ------------------------------------------------------------
const MEMBER_FIELDS = 'id, nickname, session_version, discord_name, discord_id, discord_verified_at';

export async function login(rawKey) {
  const hash = await hashKey(rawKey);

  const { data, error } = await supabase
    .from('members')
    .select(MEMBER_FIELDS)
    .eq('access_key_hash', hash)
    .maybeSingle();

  if (error) return { error: 'server' };
  if (!data) return { error: 'invalid_key' };

  return { member: data };
}

// ------------------------------------------------------------
// Персонажи пользователя (с иконкой и ролью класса)
// ------------------------------------------------------------
export async function getCharacters(memberId) {
  const { data, error } = await supabase
    .from('characters')
    .select(`
      id,
      name,
      item_level,
      combat_power,
      gold_coin_active,
      sort_order,
      updated_at,
      class_id,
      classes (
        id,
        name,
        role,
        icon_id
      )
    `)
    .eq('member_id', memberId)
    // тот же порядок, что использует приложение: sort_order, затем по ГС
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('item_level', { ascending: false });

  if (error) return { error };
  return { characters: data };
}

// ------------------------------------------------------------
// Все классы (для модалки добавления персонажа)
// ------------------------------------------------------------
export async function getClasses() {
  const { data, error } = await supabase
    .from('classes')
    .select('id, name, role, icon_id')
    .order('id', { ascending: true });

  if (error) return { error };
  return { classes: data };
}

// ------------------------------------------------------------
// Сохранение изменений одним батчем:
//   - inserted: [{ name, class_id }]  (ГС и БС у новых = 0)
//   - updated:  [{ id, name }]        (в ручном режиме меняется только имя)
//                 + служебные поля от автосинхронизации: item_level / combat_power / sort_order
//   - deleted:  [id, id, ...]
// ------------------------------------------------------------
export async function saveChanges(memberId, { inserted, updated, deleted }) {
  const errors = [];

  // 1. Удаление
  if (deleted.length > 0) {
    const { error } = await supabase
      .from('characters')
      .delete()
      .in('id', deleted);
    if (error) errors.push({ op: 'delete', error });
  }

  // 2. Обновление
  for (const ch of updated) {
    const patch = { updated_at: new Date().toISOString() };
    // Имя персонажа (меняется в режиме редактирования)
    if ('name' in ch) {
      const newName = String(ch.name ?? '').trim();
      if (!newName) {
        errors.push({ op: 'update', id: ch.id, error: new Error('Пустое имя персонажа') });
        continue;
      }
      patch.name = newName;
    }
    // ГС — numeric, БС — int8: приводим значения к типам колонок,
    // иначе PostgREST отвечает 400 Bad Request и изменения не сохраняются
    // (эти поля приходят только из автосинхронизации со статистикой)
    if ('item_level' in ch) patch.item_level = toNumeric(ch.item_level);
    if ('combat_power' in ch) patch.combat_power = toInteger(ch.combat_power);
    if ('sort_order' in ch) patch.sort_order = ch.sort_order === null ? null : toInteger(ch.sort_order);
    const { error } = await supabase
      .from('characters')
      .update(patch)
      .eq('id', ch.id);
    if (error) errors.push({ op: 'update', id: ch.id, error });
  }

  // 3. Вставка
  if (inserted.length > 0) {
    const payload = inserted.map(ch => ({
      member_id: memberId,
      name: ch.name,
      class_id: ch.class_id,
      item_level: 0,     // у нового персонажа ГС = 0
      combat_power: 0,   // и БС = 0 (обновляются автоматически)
      sort_order: ch.sort_order ?? null,
    }));

    const { error } = await supabase
      .from('characters')
      .insert(payload);
    if (error) errors.push({ op: 'insert', error });
  }

  if (errors.length > 0) return { error: errors };
  return { success: true };
}

// ------------------------------------------------------------
// Проверка доступности сервера
// ------------------------------------------------------------
export async function ping() {
  try {
    const { error } = await supabase
      .from('members')
      .select('id')
      .limit(1);
    return !error;
  } catch {
    return false;
  }
}


// ============================================================
// РЕЙДЫ — API
// ============================================================

// ------------------------------------------------------------
// Получить все рейды в диапазоне дат (с записями и классами персонажей)
// ------------------------------------------------------------
export async function getRaidsInRange(teamIds = []) {
  if (!teamIds.length) return { raids: [] };
  const { data, error } = await supabase
    .from('raids')
    .select('id,weekday,start_time,max_players,status,created_by,team_id,min_combat_power,raid_type_id,teams(id,name,leader_id),raid_types(id,name,mode,size,required_ilvl,icon_id),signups(id,character_id,member_id,role,characters(id,name,item_level,combat_power,class_id,classes(id,name,role,icon_id)))')
    .in('team_id', teamIds)
    .order('weekday').order('start_time');
  if (error) return { error };
  return { raids: data || [] };
}

// ------------------------------------------------------------
// Создать рейд
// ------------------------------------------------------------
export async function createRaid({ raid_type_id, weekday, start_time, max_players, created_by, team_id, min_combat_power = 0 }) {
  const { data, error } = await supabase.from('raids')
    .insert({ raid_type_id, weekday, start_time, max_players, status: 'open', created_by, team_id, min_combat_power })
    .select().single();
  if (error) return { error };
  return { raid: data };
}


export async function updateRaid(raidId, { weekday, start_time, min_combat_power }) {
  const patch = { weekday };
  if (start_time) patch.start_time = start_time;
  if (min_combat_power !== undefined) patch.min_combat_power = Math.max(0, Math.floor(Number(min_combat_power) || 0));
  const { data, error } = await supabase
    .from('raids')
    .update(patch)
    .eq('id', raidId)
    .select('id,weekday,start_time,min_combat_power')
    .single();

  if (error) return { error };
  return { raid: data };
}

// ------------------------------------------------------------
// Удалить рейд
// ------------------------------------------------------------
export async function deleteRaid(raidId) {
  // сначала снимаем записи (на случай, если в БД нет каскадного удаления)
  const su = await supabase.from('signups').delete().eq('raid_id', raidId);
  if (su.error) { console.error('delete signups failed:', su.error); return { error: su.error }; }
  const { error } = await supabase
    .from('raids')
    .delete()
    .eq('id', raidId);

  if (error) { console.error('delete raid failed:', error); return { error }; }
  return { success: true };
}

// Отметка «рейд пройден» (status: 'done' | 'open'). Записываться на пройденный рейд по-прежнему можно.
export async function setRaidStatus(raidId, status) {
  const { error } = await supabase.from('raids').update({ status }).eq('id', raidId);
  if (error) { console.error('set raid status failed:', error); return { error }; }
  return { success: true };
}

// Лидер: снять отметки «пройден» у всех рейдов своих команд
export async function resetRaidsDone(teamIds) {
  if (!teamIds.length) return { success: true };
  const { error } = await supabase.from('raids').update({ status: 'open' }).in('team_id', teamIds).eq('status', 'done');
  if (error) { console.error('reset raids done failed:', error); return { error }; }
  return { success: true };
}

// ------------------------------------------------------------
// Записать персонажа на рейд
// ------------------------------------------------------------
export async function signup({ raid_id, character_id, member_id, role }) {
  const { data, error } = await supabase
    .from('signups')
    .insert({
      raid_id,
      character_id,
      member_id,
      role,
    })
    .select()
    .single();

  if (error) return { error };
  return { signup: data };
}

// ------------------------------------------------------------
// Удалить запись
// ------------------------------------------------------------
export async function unsign(signupId) {
  const { error } = await supabase
    .from('signups')
    .delete()
    .eq('id', signupId);

  if (error) return { error };
  return { success: true };
}

// ------------------------------------------------------------
// Получить справочник типов рейдов (со сложностями)
// ------------------------------------------------------------
export async function getRaidTypes() {
  const { data, error } = await supabase
    .from('raid_types')
    .select('id, name, mode, size, required_ilvl, icon_id')
    .order('name', { ascending: true })
    .order('mode', { ascending: true });

  if (error) return { error };
  return { raidTypes: data };
}

// ============================================================
// СЕССИЯ И ПРОФИЛЬ
// ============================================================

// Актуальные данные участника (в т.ч. версия сессии: растёт при смене пароля)
export async function getSession(memberId) {
  const { data, error } = await supabase.from('members').select(MEMBER_FIELDS).eq('id', memberId).maybeSingle();
  if (error) return { error: 'server' };
  return { member: data || null };
}

// Разбор ошибок записи в members: 42501 — нет прав в БД, 23505 — уникальность
function memberWriteError(error, uniqueCode) {
  console.error('members write failed:', error);
  if (error?.code === '42501') return 'forbidden';
  if (error?.code === '23505') return uniqueCode;
  if (error?.code === '23514') return 'invalid';
  return 'server';
}

export async function updateNickname(memberId, nickname) {
  const n = String(nickname || '').trim();
  if (n.length < 2 || n.length > 32) return { error: 'invalid' };
  const { data, error } = await supabase.from('members').update({ nickname: n }).eq('id', memberId).select(MEMBER_FIELDS).single();
  if (error) return { error: memberWriteError(error, 'taken') };
  return { member: data };
}

// Смена пароля: новый хэш + session_version+1 → остальные устройства при следующей проверке выйдут
export async function changePassword(memberId, newKey) {
  const hash = await hashKey(newKey);
  const cur = await supabase.from('members').select('session_version').eq('id', memberId).single();
  if (cur.error) return { error: 'server' };
  const { error } = await supabase.from('members')
    .update({ access_key_hash: hash, password_changed_at: new Date().toISOString(), session_version: cur.data.session_version + 1 })
    .eq('id', memberId).eq('session_version', cur.data.session_version);
  if (error) return { error: memberWriteError(error, 'unavailable') };
  return { success: true };
}

export async function verifyPassword(memberId, key) {
  const hash = await hashKey(key);
  const { data, error } = await supabase.from('members').select('id').eq('id', memberId).eq('access_key_hash', hash).maybeSingle();
  if (error) return { error: 'server' };
  return { ok: !!data };
}

// Discord-ник: без «@», строчными. Подтверждение ботом проставит API (пока просто сохраняем).
export async function updateDiscordName(memberId, rawName) {
  const name = String(rawName || '').trim().replace(/^@+/, '').toLowerCase();
  if (name && !/^[a-z0-9_.]{2,32}$/.test(name)) return { error: 'invalid' };
  const { data, error } = await supabase.from('members').update({ discord_name: name || null }).eq('id', memberId).select(MEMBER_FIELDS).single();
  if (error) return { error: memberWriteError(error, 'invalid') };
  return { member: data };
}

// ============================================================
// КОМАНДЫ (КП)
// ============================================================
function teamError(error) {
  // сообщения триггеров БД (raise exception) — на русском, показываем как есть
  if (error?.code === 'P0001' && error.message) return error.message;
  if (error?.code === '23505') return 'duplicate';
  if (error?.code === '23514') return 'invalid';
  return 'server';
}

export async function getMyTeams(memberId) {
  const { data, error } = await supabase
    .from('team_members')
    .select('joined_at, teams(id, name, leader_id, invite_code)')
    .eq('member_id', memberId)
    .order('joined_at', { ascending: true });
  if (error) return { error };
  return { teams: (data || []).map(r => r.teams).filter(Boolean) };
}

// Состав команды + персонажи участников
export async function getTeamDetails(teamId) {
  const m = await supabase.from('team_members').select('member_id, joined_at, members(id, nickname)').eq('team_id', teamId);
  if (m.error) return { error: m.error };
  const ids = (m.data || []).map(r => r.member_id);
  let chars = [];
  if (ids.length) {
    const c = await supabase.from('characters')
      .select('id, member_id, name, item_level, combat_power, sort_order, classes(id, name, role, icon_id)')
      .in('member_id', ids)
      .order('sort_order', { ascending: true, nullsFirst: false });
    if (c.error) return { error: c.error };
    chars = c.data || [];
  }
  const members = (m.data || []).map(r => ({
    id: r.member_id,
    nickname: r.members?.nickname || '???',
    joined_at: r.joined_at,
    characters: chars.filter(ch => ch.member_id === r.member_id),
  }));
  return { members };
}

export async function createTeam(memberId, name) {
  const n = String(name || '').trim();
  if (n.length < 2 || n.length > 40) return { error: 'invalid' };
  const { data, error } = await supabase.from('teams').insert({ name: n, leader_id: memberId }).select('id, name, leader_id, invite_code').single();
  if (error) { const e = teamError(error); return { error: e === 'duplicate' ? 'name_taken' : e }; }
  return { team: data };
}

export async function joinTeam(memberId, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { error: 'invalid' };
  const t = await supabase.from('teams').select('id, name').eq('invite_code', code).maybeSingle();
  if (t.error) return { error: 'server' };
  if (!t.data) return { error: 'not_found' };
  const { error } = await supabase.from('team_members').insert({ team_id: t.data.id, member_id: memberId });
  if (error) { const e = teamError(error); return { error: e === 'duplicate' ? 'already' : e }; }
  return { team: t.data };
}

// Выход из команды / изгнание (для лидера БД не даст удалить)
export async function removeTeamMember(teamId, memberId) {
  const { error } = await supabase.from('team_members').delete().eq('team_id', teamId).eq('member_id', memberId);
  if (error) return { error: teamError(error) };
  return { success: true };
}

export async function setInviteCode(teamId, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{6,24}$/.test(code)) return { error: 'invalid' };
  const { error } = await supabase.from('teams').update({ invite_code: code }).eq('id', teamId);
  if (error) { const e = teamError(error); return { error: e === 'duplicate' ? 'code_taken' : e }; }
  return { code };
}

export async function disbandTeam(teamId) {
  const { error } = await supabase.from('teams').delete().eq('id', teamId);
  if (error) return { error: teamError(error) };
  return { success: true };
}

// ============================================================
// КРАТКИЙ ПРОФИЛЬ УЧАСТНИКА (окно по клику на игрока в расписании)
// ============================================================
export async function getMemberProfile(memberId) {
  const m = await supabase.from('members').select('id, nickname, discord_name, discord_verified_at').eq('id', memberId).maybeSingle();
  if (m.error) return { error: m.error };
  if (!m.data) return { error: new Error('not_found') };
  const c = await supabase.from('characters')
    .select('id, name, item_level, combat_power, sort_order, classes(id, name, role, icon_id)')
    .eq('member_id', memberId)
    .order('sort_order', { ascending: true, nullsFirst: false });
  if (c.error) return { error: c.error };
  const chars = c.data || [];
  let progress = [];
  if (chars.length) {
    const p = await supabase.from('character_raid_progress').select('character_id, raid_key, completed').in('character_id', chars.map(x => x.id)).eq('completed', true);
    if (p.error) return { error: p.error };
    progress = p.data || [];
  }
  return { member: m.data, characters: chars, progress };
}
