// ============================================================
// ЧИСЛОВАЯ НОРМАЛИЗАЦИЯ ГС / БС
// ГС/БС с оружейки теперь получает и сохраняет наш API (см. server-api.js);
// здесь остались только функции приведения чисел, нужные при сохранении.
// ============================================================

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
