// ============================================================
// АВТООБНОВЛЕНИЕ ГС / БС ЧЕРЕЗ VITEWORKER-ПРОКСИ
// ============================================================
// Логика парсинга взята из тестового скрипта сравнения персонажей:
//   воркер (PROXY) отдаёт HTML страницы «Оружейная» с лостарк.рф,
//   мы вытаскиваем из него рейтинг снаряжения (ГС) и боеспособность (БС).
// Здесь то же самое, но:
//   - запрос идёт для каждого персонажа игрока;
//   - значения сравниваются с текущими в state;
//   - при изменении — обновляются в панели «Мои персонажи» и сохраняются в Supabase.

const BASE_URL = 'https://лостарк.рф/Оружейная/';
const PROXY    = 'https://lostark-proxy.iliayay200.workers.dev/?url=';

// Кэш последних результатов на время сессии: name -> { gearValue, combatValue }
const statsCache = new Map();

// ------------------------------------------------------------
// Запрос + парсинг одного персонажа (как в тестовом скрипте)
// Возвращает { gearValue, combatValue } или null, если ничего не найдено
// ------------------------------------------------------------
export async function fetchCharacterStats(name) {
  const target = BASE_URL + encodeURIComponent(name);
  const url = PROXY + encodeURIComponent(target);

  console.log('[stats fetch]', url);

  const resp = await fetch(url);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);

  const html = await resp.text();
  console.log('[stats fetch] length =', html.length);

  const doc = new DOMParser().parseFromString(html, 'text/html');

  // ГС: .level-info2__expedition → второй span ("Ур. 1745.42")
  const gearEl = doc.querySelector('.level-info2__expedition');
  let gearValue = null;
  if (gearEl) {
    const valueSpan = gearEl.querySelectorAll('span')[1];
    if (valueSpan) {
      gearValue = valueSpan.textContent.replace(/\s+/g, '').replace(/^Ур\.?/i, '');
    }
  }

  // БС: .level-info2__item → второй span ("6013")
  const combatEl = doc.querySelector('.level-info2__item');
  let combatValue = null;
  if (combatEl) {
    const valueSpan = combatEl.querySelectorAll('span')[1];
    if (valueSpan) {
      combatValue = valueSpan.textContent.replace(/\s+/g, '');
    }
  }

  console.log('[stats parsed]', name, gearValue, combatValue);

  if (gearValue === null && combatValue === null) return null;
  return { gearValue, combatValue };
}

// ------------------------------------------------------------
// "1 745,42" / "Ур.1745.42" -> number | null
// ------------------------------------------------------------
function parseNum(str) {
  if (str === null || str === undefined) return null;
  const cleaned = String(str).replace(/[\s\u00A0]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------
// Обновить ГС/БС всех персонажей через воркер.
//   characters — массив из state.characters
//   onPersist(item_level|combat_power changes) — вызывается,
//       если есть изменения, чтобы вызвать saveChanges в Supabase
// Возвращает { changed: [...], errors: [...] }
// ------------------------------------------------------------
export async function refreshCharactersStats(characters, onPersist) {
  const alive = characters.filter(c => c.name && !String(c.id).startsWith('temp_'));
  if (alive.length === 0) return { changed: [], errors: [] };

  const results = await Promise.allSettled(
    alive.map(async ch => {
      if (statsCache.has(ch.name)) return statsCache.get(ch.name);
      const s = await fetchCharacterStats(ch.name);
      if (s) statsCache.set(ch.name, s);
      return s;
    })
  );

  const changed = [];
  const errors = [];

  results.forEach((res, i) => {
    const ch = alive[i];

    if (res.status === 'rejected') {
      errors.push({ name: ch.name, reason: res.reason });
      console.error('[stats error]', ch.name, res.reason);
      return;
    }

    const s = res.value;
    if (!s) {
      errors.push({ name: ch.name, reason: new Error('не найдено на сайте статистики') });
      return;
    }

    const patch = { id: ch.id };
    let dirty = false;

    // ГС
    const newGs = parseNum(s.gearValue);
    if (newGs !== null && newGs !== parseNum(ch.item_level)) {
      patch.item_level = newGs;
      dirty = true;
    }

    // БС
    const newBs = parseNum(s.combatValue);
    if (newBs !== null && newBs !== parseNum(ch.combat_power)) {
      patch.combat_power = newBs;
      dirty = true;
    }

    if (dirty) {
      // применяем локально к объекту персонажа (панель обновится после render)
      if ('item_level' in patch) ch.item_level = patch.item_level;
      if ('combat_power' in patch) ch.combat_power = patch.combat_power;
      changed.push(patch);
    }
  });

  // Сохраняем изменения в базу (через колбэк, чтобы не тащить сюда api.js)
  if (changed.length > 0 && typeof onPersist === 'function') {
    try {
      await onPersist(changed);
    } catch (e) {
      console.error('[stats persist error]', e);
    }
  }

  return { changed, errors };
}
