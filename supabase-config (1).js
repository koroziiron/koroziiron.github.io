// ============================================================
// КОНФИГ SUPABASE
// ============================================================
// Эти значения — публичные, их видит любой пользователь в DevTools.
// Защита данных — через RLS (политики в Supabase), а не через сокрытие ключа.

export const SUPABASE_URL = 'https://lpxlkwhhpyvelzugkcvv.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_DYrMWxijgmYZjf5Q3pgR4g_pBYweW0k';

// Соль для хеширования ключей доступа.
// НЕ МЕНЯТЬ после создания первого члена КП!
export const ACCESS_KEY_SALT = 'drugs';