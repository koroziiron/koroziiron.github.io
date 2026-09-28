
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY, ACCESS_KEY_SALT } from './supabase-config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------- Авторизация ----------

export async function hashKey(rawKey) {
  const bytes = new TextEncoder().encode(ACCESS_KEY_SALT + rawKey);
  const hash = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function login(rawKey) {
  const hash = await hashKey(rawKey);

  const { data, error } = await supabase
    .from('members')
    .select('id, nickname')
    .eq('access_key_hash', hash)
    .maybeSingle();

  if (error) return { error: 'server' };
  if (!data) return { error: 'invalid_key' };

  return { member: data };
}

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

// ---------- Персонажи ----------

export async function getCharacters(memberId) {
  const { data, error } = await supabase
    .from('characters')
    .select(`
      id,
      member_id,
      name,
      item_level,
      combat_power,
      class_id,
      sort_order,
      gold_coin_active,
      created_at,
      classes (
        id,
        name,
        role,
        icon_id
      )
    `)
    .eq('member_id', memberId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) return { error };
  return { characters: data || [] };
}

export async function getClasses() {
  const { data, error } = await supabase
    .from('classes')
    .select('id, name, role, icon_id')
    .order('id', { ascending: true });

  if (error) return { error };
  return { classes: data || [] };
}

export async function saveChanges(memberId, { inserted = [], updated = [], deleted = [] }) {
  const errors = [];

  if (deleted.length) {
    const { error } = await supabase
      .from('characters')
      .delete()
      .eq('member_id', memberId)
      .in('id', deleted);

    if (error) errors.push({ op: 'delete', error });
  }

  for (const ch of updated) {
    const { error } = await supabase
      .from('characters')
      .update({
        item_level: ch.item_level,
        combat_power: ch.combat_power,
        updated_at: new Date().toISOString()
      })
      .eq('member_id', memberId)
      .eq('id', ch.id);

    if (error) errors.push({ op: 'update', id: ch.id, error });
  }

  if (inserted.length) {
    const payload = inserted.map(ch => ({
      member_id: memberId,
      name: ch.name,
      class_id: ch.class_id,
      item_level: ch.item_level,
      combat_power: ch.combat_power
    }));

    const { error } = await supabase
      .from('characters')
      .insert(payload);

    if (error) errors.push({ op: 'insert', error });
  }

  return errors.length ? { error: errors } : { success: true };
}

// ---------- Справочник рейдов ----------

export async function getRaidTypes() {
  const { data, error } = await supabase
    .from('raid_types')
    .select('id, name, mode, size, required_ilvl, icon_id')
    .order('name', { ascending: true })
    .order('mode', { ascending: true });

  if (error) return { error };
  return { raidTypes: data || [] };
}

// ---------- Расписание ----------

// weekday: ISO день недели, 1 = понедельник ... 7 = воскресенье.
// Слоты повторяются еженедельно, поэтому рейды загружаются без datetime.

export async function getRaidsInRange() {
  const { data, error } = await supabase
    .from('raids')
    .select(`
      id,
      weekday,
      start_time,
      max_players,
      status,
      created_by,
      raid_type_id,
      raid_types (
        id,
        name,
        mode,
        size,
        required_ilvl,
        icon_id
      ),
      signups (
        id,
        character_id,
        member_id,
        role,
        week_start,
        raid_key,
        characters (
          id,
          name,
          item_level,
          combat_power,
          class_id,
          classes (
            id,
            name,
            role,
            icon_id
          )
        )
      )
    `)
    .order('weekday', { ascending: true })
    .order('start_time', { ascending: true });

  if (error) return { error };
  return { raids: data || [] };
}

export async function createRaid({
  raid_type_id,
  weekday,
  start_time,
  max_players,
  created_by
}) {
  const { data, error } = await supabase
    .from('raids')
    .insert({
      raid_type_id,
      weekday,
      start_time,
      max_players,
      status: 'open',
      created_by
    })
    .select()
    .single();

  if (error) return { error };
  return { raid: data };
}

export async function deleteRaid(raidId) {
  const { error } = await supabase
    .from('raids')
    .delete()
    .eq('id', raidId);

  if (error) return { error };
  return { success: true };
}

// ---------- Записи ----------

export async function signup({
  raid_id,
  character_id,
  member_id,
  role,
  week_start,
  raid_key
}) {
  const { data, error } = await supabase
    .from('signups')
    .insert({
      raid_id,
      character_id,
      member_id,
      role,
      week_start,
      raid_key
    })
    .select()
    .single();

  if (error) return { error };
  return { signup: data };
}

export async function unsign(signupId) {
  const { error } = await supabase
    .from('signups')
    .delete()
    .eq('id', signupId);

  if (error) return { error };
  return { success: true };
}
