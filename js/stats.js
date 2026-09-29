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
// Нормализация имени персонажа для сравнения с БД.
// На лостарк.рф имена могут писаться с пробелами («Эроманга Сэнсэй»),
// а в базе храниться слитно («ЭромангаСэнсэй») — сравниваем «по-лояльно»:
// без пробелов и регистра.
// ------------------------------------------------------------
export function normalizeName(name) {
  return String(name || '').replace(/[\s\u00A0]+/g, '').toLowerCase();
}

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
// Разбор чисел со страницы статистики -> number | null
// Форматы на сайте:
//   "1,212.24"  — запятая разделяет тысячи, точка — десятичный разделитель
//                 (в DOM дробная часть лежит в <small>, после textContent
//                  склеивается в "...,xxx.yy")
//   "6013"      — целое без разделителей
//   "1 745,42" / "Ур.1745.42" — варианты из ручного ввода / старых данных
// ------------------------------------------------------------
export function parseNum(str) {
  if (str === null || str === undefined) return null;

  let s = String(str)
    .replace(/[\s\u00A0]/g, '')   // убираем пробелы (в т.ч. неразрывные)
    .replace(/^Ур\.?/i, '');      // убираем префикс "Ур."

  // Две точки подряд ("1.740..00") — артефакт склейки span+small:
  // первая точка — разделитель тысяч, вторая — десятичная.
  // Убираем именно первую из пары: "1.740..00" -> "1740.00" -> 1740
  s = s.replace(/(\d)\.\.(?=\d)/, '$1.');

  const dotCount = (s.match(/\./g) || []).length;
  const commaCount = (s.match(/,/g) || []).length;

  if (dotCount > 1 && commaCount === 0) {
    // Несколько точек без запятых ("1.740.00") — все, кроме последней,
    // это разделители тысяч
    const lastDot = s.lastIndexOf('.');
    s = s.slice(0, lastDot).replace(/\./g, '') + s.slice(lastDot);
  } else if (dotCount > 0 && commaCount > 0) {
    // Оба разделителя: тот, что правее — десятичный, остальные — тысячи
    if (s.lastIndexOf('.') > s.lastIndexOf(',')) {
      s = s.replace(/,/g, '');            // "1,212.24" -> "1212.24"
    } else {
      s = s.replace(/\./g, '').replace(',', '.'); // "1.212,24" -> "1212.24"
    }
  } else if (commaCount === 1) {
    // Только запятая: если после неё ровно 3 цифры и есть цифры до —
    // это разделитель тысяч ("1,212"), иначе десятичный ("1745,42")
    s = s.replace(/,/g, (match, offset) => {
      const after = s.slice(offset + 1);
      return /^\d{3}$/.test(after) ? '' : '.';
    });
  } else if (commaCount > 1) {
    s = s.replace(/,/g, '');              // "1,212,240" -> "1212240"
  }
  // одна точка или ни одного разделителя — оставляем как есть

  const n = parseFloat(s);
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
