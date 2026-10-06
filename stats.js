// ============================================================
// АВТООБНОВЛЕНИЕ ГС / БС — ПУЛ ПРОКСИ + ТИХИЙ FALLBACK
// ============================================================
// Пробуем Cloudflare, затем бесплатные публичные CORS-прокси.
// Если ни один источник не отдаёт валидные показатели — возвращаем null,
// не меняем данные в БД и не показываем пользователю ошибку.

const BASE_URL = 'https://лостарк.рф/Оружейная/';
const PROXY_POOL = [
  {
    name: 'Cloudflare',
    build: target => 'https://lostark-proxy.iliayay200.workers.dev/?url=' + encodeURIComponent(target),
  },
  {
    name: 'AllOrigins',
    build: target => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(target),
  },
  {
    name: 'CorsProxy',
    build: target => 'https://corsproxy.io/?url=' + encodeURIComponent(target),
  },
];

const REQUEST_TIMEOUT_MS = 4000;
const statsCache = new Map();

async function fetchTextWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseStatsHtml(html) {
  if (!html || html.length < 500) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const gearEl = doc.querySelector('.level-info2__expedition');
  const combatEl = doc.querySelector('.level-info2__item');
  const gearValue = gearEl?.querySelectorAll('span')[1]?.textContent
    ?.replace(/\s+/g, '').replace(/^Ур\.?/i, '') ?? null;
  const combatValue = combatEl?.querySelectorAll('span')[1]?.textContent
    ?.replace(/\s+/g, '') ?? null;

  const gear = toNumeric(gearValue);
  const combat = toInteger(combatValue);
  if (gear === null && combat === null) return null;
  return { gearValue, combatValue };
}

export async function fetchCharacterStats(name) {
  const target = BASE_URL + encodeURIComponent(name);

  // Основной Worker пробуем первым. Резервные открытые прокси запускаем
  // параллельно после его таймаута, чтобы не складывать задержки.
  const primaryHtml = await fetchTextWithTimeout(PROXY_POOL[0].build(target));
  const primaryStats = parseStatsHtml(primaryHtml);
  if (primaryStats) return primaryStats;

  const fallbacks = await Promise.all(
    PROXY_POOL.slice(1).map(async proxy => {
      const html = await fetchTextWithTimeout(proxy.build(target));
      return parseStatsHtml(html);
    })
  );
  return fallbacks.find(Boolean) || null;
}

// Числовая нормализация
export function parseNum(str) {
  if (str === null || str === undefined) return null;
  let s = String(str).replace(/[\s\u00A0]/g, '').replace(/^Ур\.?/i, '');
  s = s.replace(/(\d)\.\.(?=\d)/, '$1.');
  const dotCount = (s.match(/\./g) || []).length;
  const commaCount = (s.match(/,/g) || []).length;

  if (dotCount > 1 && commaCount === 0) {
    const lastDot = s.lastIndexOf('.');
    s = s.slice(0, lastDot).replace(/\./g, '') + s.slice(lastDot);
  } else if (dotCount > 0 && commaCount > 0) {
    if (s.lastIndexOf('.') > s.lastIndexOf(',')) s = s.replace(/,/g, '');
    else s = s.replace(/\./g, '').replace(',', '.');
  } else if (commaCount === 1) {
    s = s.replace(/,/g, (match, offset) => /^\d{3}$/.test(s.slice(offset + 1)) ? '' : '.');
  } else if (commaCount > 1) {
    s = s.replace(/,/g, '');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export function toNumeric(val) {
  if (val === null || val === undefined || String(val).trim() === '') return null;
  const n = typeof val === 'number' ? val : parseNum(val);
  return Number.isFinite(n) ? n : null;
}

export function toInteger(val) {
  const n = toNumeric(val);
  return n === null ? null : Math.round(n);
}

export async function refreshCharactersStats(characters, onPersist) {
  const alive = characters.filter(c => c.name && !String(c.id).startsWith('temp_'));
  if (!alive.length) return { changed: [], errors: [] };

  const results = await Promise.all(alive.map(async ch => {
    if (statsCache.has(ch.name)) return statsCache.get(ch.name);
    const stats = await fetchCharacterStats(ch.name);
    if (stats) statsCache.set(ch.name, stats);
    return stats;
  }));

  const changed = [];
  results.forEach((stats, i) => {
    if (!stats) return; // тихо оставляем значения из БД
    const ch = alive[i];
    const patch = { id: ch.id };
    const newGs = toNumeric(stats.gearValue);
    const newBs = toInteger(stats.combatValue);
    if (newGs !== null && newGs !== toNumeric(ch.item_level)) patch.item_level = newGs;
    if (newBs !== null && newBs !== toInteger(ch.combat_power)) patch.combat_power = newBs;

    if (Object.keys(patch).length > 1) {
      changed.push(patch);
    }
  });

  if (changed.length && typeof onPersist === 'function') {
    try {
      const result = await onPersist(changed);
      if (result?.error) {
        // Не меняем state, если запись новых значений в БД не удалась.
        return { changed: [], errors: ['persist'] };
      }
    } catch {
      // Тихо оставляем значения из БД.
      return { changed: [], errors: ['persist'] };
    }
  }

  // Только после успешного получения и, если нужно, сохранения применяем
  // новые значения к объектам, которые уже показаны пользователю.
  for (const patch of changed) {
    const ch = alive.find(c => String(c.id) === String(patch.id));
    if (!ch) continue;
    if ('item_level' in patch) ch.item_level = patch.item_level;
    if ('combat_power' in patch) ch.combat_power = patch.combat_power;
  }

  return { changed, errors: [] };
}
