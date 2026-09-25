// ============================================================
// СЛОЙ РАБОТЫ С SUPABASE
// ============================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY, ACCESS_KEY_SALT } from './supabase-config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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
      class_id,
      classes (
        id,
        name,
        role,
        icon_id
      )
    `)
    .eq('member_id', memberId)
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
//   - inserted: [{ name, class_id, item_level, combat_power }]
//   - updated:  [{ id, item_level, combat_power }]
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
    const { error } = await supabase
      .from('characters')
      .update({
        item_level: ch.item_level,
        combat_power: ch.combat_power,
        updated_at: new Date().toISOString(),
      })
      .eq('id', ch.id);
    if (error) errors.push({ op: 'update', id: ch.id, error });
  }

  // 3. Вставка
  if (inserted.length > 0) {
    const payload = inserted.map(ch => ({
      member_id: memberId,
      name: ch.name,
      class_id: ch.class_id,
      item_level: ch.item_level,
      combat_power: ch.combat_power,
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