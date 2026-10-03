// ============================================================
// ОСНОВНАЯ ЛОГИКА UI
// ============================================================
import {
  login,
  getCharacters,
  getClasses,
  saveChanges,
  ping,
  getRaidsInRange,
  createRaid,
  updateRaid,
  deleteRaid,
  signup,
  unsign,
  getRaidTypes,
  supabase as dragonsSupabase,
} from './api.js';
import { refreshCharactersStats } from './stats.js';
window.dragonsSupabase = dragonsSupabase;

// ------------------------------------------------------------
// ГЛОБАЛЬНОЕ СОСТОЯНИЕ
// ------------------------------------------------------------
const state = {
  member: null,
  characters: [],
  classes: [],
  editMode: false,
  draft: {
    updated: {},
    inserted: [],
    deleted: new Set(),
  },
  pendingClass: null,
  editingRaidId: null,
  selectedRaidWeekday: 3,
  tempIdCounter: 0,

  // НОВОЕ:
  raids: [],              // все рейды расписания
  raidTypes: [],          // справочник рейдов из БД
    draggingCharacter: null,// персонаж, которого тащат
};

// ------------------------------------------------------------
// ССЫЛКИ НА DOM
// ------------------------------------------------------------
const $ = id => document.getElementById(id);
const screens = {
  loading: $('screen-loading'),
  offline: $('screen-offline'),
  login:   $('screen-login'),
  main:    $('screen-main'),
};

// ------------------------------------------------------------
// УПРАВЛЕНИЕ ЭКРАНАМИ
// ------------------------------------------------------------
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// ------------------------------------------------------------
// ТОСТ
// ------------------------------------------------------------
let toastTimer = null;
function showToast(text, type = '') {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
  }, 3000);
}

// ------------------------------------------------------------
// ИНИЦИАЛИЗАЦИЯ
// ------------------------------------------------------------
async function init() {
  showScreen('loading');
  // Проверяем доступность сервера
  const ok = await ping();
  if (!ok) {
    showScreen('offline');
    return;
  }
  // Публичное расписание загружаем до авторизации. Ошибка чтения
  // не должна блокировать вход или основной интерфейс.
  try {
    await loadRaids();
    renderSchedule();
  } catch (err) {
    console.warn('Не удалось загрузить публичное расписание', err);
  }
  // Проверяем сохранённую сессию
  const savedMember = localStorage.getItem('kp_member');
  if (savedMember) {
    try {
      state.member = JSON.parse(savedMember);
      await enterMain();
      return;
    } catch {
      localStorage.removeItem('kp_member');
    }
  }
  showScreen('login');
}

// ------------------------------------------------------------
// ЛОГИН
// ------------------------------------------------------------
$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('login-key');
  const key = input.value.trim();
  if (!key) {
    shakeElement($('login-form'));
    return;
  }
  const result = await login(key);
  if (result.error === 'server') {
    showScreen('offline');
    return;
  }
  if (result.error === 'invalid_key') {
    shakeElement($('login-form'), true);
    input.value = '';
    input.focus();
    return;
  }
  // Успех
  state.member = result.member;
  localStorage.setItem('kp_member', JSON.stringify(state.member));
  await enterMain();
});

function shakeElement(el, red = false) {
  el.classList.remove('shake', 'shake-red');
  // Force reflow
  void el.offsetWidth;
  el.classList.add(red ? 'shake-red' : 'shake');
  setTimeout(() => el.classList.remove('shake', 'shake-red'), 600);
}

// ------------------------------------------------------------
// ВХОД В ОСНОВНОЙ ЭКРАН
// ------------------------------------------------------------
async function enterMain() {
  $('header-nickname').textContent = state.member.nickname;
  showScreen('main');

  if (state.classes.length === 0) {
    const r = await getClasses();
    if (r.classes) state.classes = r.classes;
  }

  if (state.raidTypes.length === 0) {
    const r = await getRaidTypes();
    if (r.raidTypes) state.raidTypes = r.raidTypes;
  }

  await loadCharacters();

  // Сначала показываем сохранённые значения и расписание без ожидания парсера.
  await loadRaids();
  renderCharacters();
  renderSchedule();

  // Обновление ГС/БС идёт в фоне; сбой источников не блокирует вход.
  void syncStatsFromWorker();
}

// ------------------------------------------------------------
// СИНХРОНИЗАЦИЯ ГС/БС ЧЕРЕЗ WORKER-ПРОКСИ
//   1. для каждого персонажа запрашиваем страницу «Оружейная» через воркер;
//   2. спарсенные ГС/БС сравниваем с текущими — при изменении обновляем
//      объекты в state (панелька «Мои персонажи» перерисуется);
//   3. изменения пушем в Supabase (saveChanges → updated).
// Ошибки не блокируют вход: показываем то, что есть в базе.
// ------------------------------------------------------------
let statsSyncing = false;

async function syncStatsFromWorker() {
  if (!state.member || state.characters.length === 0) return;
  if (statsSyncing) return;
  statsSyncing = true;
  try {
    const { changed, errors } = await refreshCharactersStats(
      state.characters,
      async (patches) => {
        // Сохраняем новые ГС/БС в базу одним вызовом
        const r = await saveChanges(state.member.id, {
          inserted: [],
          updated: patches,
          deleted: [],
        });
        if (r.error) console.error('[stats] persist failed', r.error);
      }
    );

    if (changed.length > 0) {
      showToast(`ГС/БС обновлены: ${changed.length} шт.`, 'success');
      // значения уже применены к state.characters — панелька и табличка
      // перерисуются сразу после возврата из syncStatsFromWorker в enterMain;
      // здесь подстраховываемся на случай вызова не из входа
      renderCharacters();
      syncRaidBoardWithCharacters();
    } else if (errors.length === errorsTotal(state.characters)) {
      // вообще ничего не удалось получить — тихо оставляем значения из БД
      console.warn('[stats] worker returned nothing usable');
    }
  } finally {
    statsSyncing = false;
  }
}

function errorsTotal(characters) {
  return characters.filter(c => c.name && !String(c.id).startsWith('temp_')).length;
}

// ------------------------------------------------------------
// ВЫХОД
// ------------------------------------------------------------
$('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('kp_member');
  state.member = null;
  state.characters = [];
  state.editMode = false;
  resetDraft();
  $('login-key').value = '';
  showScreen('login');
});

// ------------------------------------------------------------
// ЗАГРУЗКА ПЕРСОНАЖЕЙ
// ------------------------------------------------------------
async function loadCharacters() {
  const r = await getCharacters(state.member.id);
  if (r.error) {
    showToast('Не удалось загрузить персонажей', 'error');
    return;
  }
  state.characters = r.characters || [];
}

// ------------------------------------------------------------
// СБРОС ЧЕРНОВИКА
// ------------------------------------------------------------
function resetDraft() {
  state.draft = {
    updated: {},
    inserted: [],
    deleted: new Set(),
  };
  state.pendingClass = null;
}

// ------------------------------------------------------------
// ОБЩИЙ ПОРЯДОК ПЕРСОНАЖЕЙ
// Список «Мои персонажи» и табличка рейдов используют один и тот же
// порядок: sort_order из БД (ставится drag&drop в табличке рейдов).
// ------------------------------------------------------------
function compareBySortOrder(a, b) {
  const sa = Number(a.sort_order);
  const sb = Number(b.sort_order);
  const va = Number.isFinite(sa) && sa !== 0 ? sa : Infinity;
  const vb = Number.isFinite(sb) && sb !== 0 ? sb : Infinity;
  if (va !== vb) return va - vb;
  // стабильный тай-брейк: сначала по имени, затем по ГС —
  // так список и табличка всегда совпадают даже при равных sort_order
  const na = String(a.name || '').localeCompare(String(b.name || ''), 'ru');
  if (na !== 0) return na;
  return (Number(b.item_level) || 0) - (Number(a.item_level) || 0);
}

function sortedCharacters() {
  return [...state.characters].sort(compareBySortOrder);
}

// Максимальный текущий sort_order (для добавления новых персонажей в конец)
function maxSortOrder() {
  let m = 0;
  for (const ch of state.characters) {
    const v = Number(ch.sort_order);
    if (Number.isFinite(v) && v > m) m = v;
  }
  return m;
}

// ------------------------------------------------------------
// РЕНДЕР СПИСКА ПЕРСОНАЖЕЙ
// ------------------------------------------------------------
function renderCharacters(opts = {}) {
  const syncingStats = opts.syncingStats === true;
  const list = $('characters-list');
  list.innerHTML = '';
  // Существующие персонажи — в том же порядке, что и в табличке рейдов
  for (const ch of sortedCharacters()) {
    list.appendChild(buildCharCard(ch, false, syncingStats));
  }
  // Локально созданные (ещё не в БД)
  for (const ch of state.draft.inserted) {
    list.appendChild(buildCharCard(ch, true, syncingStats));
  }
  // Кнопка "+" в режиме редактирования
  const addBtn = $('add-character-btn');
  if (state.editMode) {
    addBtn.classList.remove('hidden');
  } else {
    addBtn.classList.add('hidden');
  }
  // Класс на панели
  const panel = document.querySelector('.characters-panel');
  panel.classList.toggle('edit-mode', state.editMode);
}

// ------------------------------------------------------------
// ПОСТРОЕНИЕ КАРТОЧКИ ПЕРСОНАЖА
// ------------------------------------------------------------
function buildCharCard(ch, isNew, syncingStats = false) {
  const card = document.createElement('div');
  card.className = 'char-card';
  card.dataset.charId = ch.id;
card.draggable = true;  // ← НОВОЕ

  // НОВОЕ: drag
  card.addEventListener('dragstart', e => {
    state.draggingCharacter = ch;
    e.dataTransfer.setData('text/character-id', ch.id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => {
    state.draggingCharacter = null;
    card.classList.remove('dragging');
  });
  
  // Помечен на удаление?
  if (state.draft.deleted.has(ch.id)) {
    card.classList.add('marked-delete');
  }
  
  // Иконка
  const iconWrap = document.createElement('div');
  iconWrap.className = 'char-icon-wrap';
  
  // ПРАВКА 1: Блик для hover-эффекта
  const shine = document.createElement('span');
  shine.className = 'shine';
  iconWrap.appendChild(shine);
  
  const iconSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  iconSvg.setAttribute('class', 'char-icon');
  const iconId = ch.classes?.icon_id || ch.icon_id || 'berserker';
  const viewBox = getIconViewBox(iconId);
  iconSvg.setAttribute('viewBox', viewBox);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + iconId);
  iconSvg.appendChild(use);
  iconWrap.appendChild(iconSvg);
  
  // В режиме редактирования — клик удаления/восстановления
  if (state.editMode) {
    iconWrap.addEventListener('click', e => {
      e.stopPropagation();
      toggleDelete(ch.id);
    });
  }
  
  // Информация
  const info = document.createElement('div');
  info.className = 'char-info';

  // ИМЯ: в режиме редактирования — поле ввода (менять можно только его),
  // в обычном режиме — обычный текст. ГС/БС вручную менять нельзя:
  // они обновляются только автоматически через сайт статистики.
  let nameEl;
  if (state.editMode && !state.draft.deleted.has(ch.id)) {
    nameEl = document.createElement('input');
    nameEl.type = 'text';
    nameEl.className = 'char-name char-name-input';
    nameEl.value = ch.name || '';
    nameEl.placeholder = 'Имя персонажа';
    nameEl.maxLength = 30;
    // при набранном имени drag-перетаскивание карточки мешает выделению текста
    nameEl.addEventListener('mousedown', e => e.stopPropagation());
    nameEl.addEventListener('click', e => e.stopPropagation());
    nameEl.addEventListener('input', () => {
      const newName = nameEl.value.trim();
      if (isNew) {
        ch.name = newName;
      } else {
        state.draft.updated[ch.id] = state.draft.updated[ch.id] || {
          id: ch.id,
          name: ch.name,
        };
        state.draft.updated[ch.id].name = newName;
      }
    });
  } else {
    nameEl = document.createElement('div');
    nameEl.className = 'char-name';
    nameEl.textContent = ch.name;
  }

  const stats = document.createElement('div');
  stats.className = 'char-stats';
  const role = ch.classes?.role || ch.role || 'DPS';

  // Пустые значения ГС/БС (null / undefined / '') показываем как пустое поле, а не 0
  const hasGs = ch.item_level !== null && ch.item_level !== undefined && String(ch.item_level).trim() !== '';
  const hasBs = ch.combat_power !== null && ch.combat_power !== undefined && String(ch.combat_power).trim() !== '';

  // GS (только для чтения)
  const gsWrap = document.createElement('span');
  if (syncingStats && !isNew) {
    // Пока воркер проверяет значения на сайте статистики — заглушка
    gsWrap.className = 'stat-syncing';
    gsWrap.textContent = '…';
    gsWrap.title = 'Обновление ГС через сайт статистики';
  } else {
    gsWrap.className = getGsClass(ch.item_level);
    gsWrap.textContent = hasGs ? ch.item_level : '';
  }

  // BS (только для чтения)
  const bsWrap = document.createElement('span');
  if (syncingStats && !isNew) {
    bsWrap.className = 'stat-syncing';
    bsWrap.textContent = '…';
    bsWrap.title = 'Обновление БС через сайт статистики';
  } else {
    bsWrap.className = role === 'SUPPORT' ? 'bs-support' : 'bs-dps';
    bsWrap.textContent = hasBs ? ch.combat_power : '';
  }

  stats.appendChild(gsWrap);
  stats.appendChild(bsWrap);
  info.appendChild(nameEl);
  info.appendChild(stats);
  
  card.appendChild(iconWrap);
  card.appendChild(info);
  return card;
}

// ------------------------------------------------------------
// ОПРЕДЕЛЕНИЕ КЛАССА GS ПО ЗНАЧЕНИЮ
// ------------------------------------------------------------
function getGsClass(gs) {
  const n = parseFloat(gs) || 0;
  if (n < 1700) return 'gs-grey';
  if (n < 1730) return 'gs-silver';
  if (n < 1750) return 'gs-gold';
  return 'gs-crystal';
}

// ------------------------------------------------------------
// VIEWBOX ДЛЯ ИКОНОК
// (берём из спрайта, но для ускорения — кэш)
// ------------------------------------------------------------
const VIEWBOX_CACHE = {};
function getIconViewBox(iconId) {
  if (VIEWBOX_CACHE[iconId]) return VIEWBOX_CACHE[iconId];
  const symbol = document.querySelector('#' + iconId);
  if (symbol) {
    const vb = symbol.getAttribute('viewBox') || '0 0 100 100';
    VIEWBOX_CACHE[iconId] = vb;
    return vb;
  }
  return '0 0 100 100';
}

// ------------------------------------------------------------
// УДАЛЕНИЕ / ВОССТАНОВЛЕНИЕ ПЕРСОНАЖА
// ------------------------------------------------------------
function toggleDelete(charId) {
  // Если это локально созданный — просто удаляем из inserted
  const isLocal = state.draft.inserted.some(c => c.id === charId);
  if (isLocal) {
    state.draft.inserted = state.draft.inserted.filter(c => c.id !== charId);
    renderCharacters();
    return;
  }
  // Иначе — переключаем в deleted
  if (state.draft.deleted.has(charId)) {
    state.draft.deleted.delete(charId);
  } else {
    state.draft.deleted.add(charId);
  }
  renderCharacters();
}

// ------------------------------------------------------------
// КНОПКА РЕДАКТИРОВАНИЯ
// ------------------------------------------------------------
$('edit-btn').addEventListener('click', () => {
  state.editMode = true;
  $('edit-btn').classList.add('hidden');
  $('cancel-btn').classList.remove('hidden');
  $('save-btn').classList.remove('hidden');
  renderCharacters();
});

// ------------------------------------------------------------
// КНОПКА ОТМЕНЫ
// ------------------------------------------------------------
$('cancel-btn').addEventListener('click', () => {
  state.editMode = false;
  resetDraft();
  $('edit-btn').classList.remove('hidden');
  $('cancel-btn').classList.add('hidden');
  $('save-btn').classList.add('hidden');
  renderCharacters();
});

// ------------------------------------------------------------
// КНОПКА СОХРАНЕНИЯ
// ------------------------------------------------------------
$('save-btn').addEventListener('click', async () => {
  // Проверка имён: пустые и дубликаты не сохраняем
  const nameErrors = [];
  for (const c of state.draft.inserted) {
    if (!c.name || !c.name.trim()) nameErrors.push('(пустое имя)');
  }
  for (const ch of state.characters) {
    if (state.draft.deleted.has(ch.id)) continue;
    const upd = state.draft.updated[ch.id];
    if (upd && 'name' in upd) {
      const newName = String(upd.name || '').trim();
      if (!newName) {
        nameErrors.push(ch.name);
        continue;
      }
      const dupeDb = state.characters.some(o =>
        o.id !== ch.id && !state.draft.deleted.has(o.id) && o.name === newName);
      const dupeNew = state.draft.inserted.some(c => c.name === newName);
      if (dupeDb || dupeNew) nameErrors.push(newName);
    }
  }
  if (nameErrors.length > 0) {
    showToast(`Имя пусто или уже занято: ${nameErrors.join(', ')}`, 'error');
    return;
  }

  const inserted = state.draft.inserted.map((c, i) => ({
    name: c.name,
    class_id: c.class_id,
    item_level: 0,   // у нового персонажа ГС и БС = 0 (обновляются автоматически)
    combat_power: 0,
    sort_order: (maxSortOrder() + 1 + i), // новые — в конец списка
  }));
  const updated = Object.values(state.draft.updated);
  const deleted = Array.from(state.draft.deleted);
  
  if (inserted.length === 0 && updated.length === 0 && deleted.length === 0) {
    // Ничего не изменилось — просто выходим
    state.editMode = false;
    resetDraft();
    $('edit-btn').classList.remove('hidden');
    $('cancel-btn').classList.add('hidden');
    $('save-btn').classList.add('hidden');
    renderCharacters();
    return;
  }
  
  const r = await saveChanges(state.member.id, { inserted, updated, deleted });
  if (r.error) {
    showToast('Ошибка сохранения', 'error');
    console.error(r.error);
    return;
  }
  
  showToast('Сохранено', 'success');
  state.editMode = false;
  resetDraft();
  $('edit-btn').classList.remove('hidden');
  $('cancel-btn').classList.add('hidden');
  $('save-btn').classList.add('hidden');
  await loadCharacters();
  renderCharacters();
  syncRaidBoardWithCharacters();
});

// ------------------------------------------------------------
// ОТКРЫТИЕ МОДАЛКИ ВЫБОРА КЛАССА
// ------------------------------------------------------------
$('add-character-btn').addEventListener('click', openClassModal);

function openClassModal() {
  state.pendingClass = null;
  $('modal-step-classes').classList.add('active');
  $('modal-step-name').classList.remove('active');
  $('modal-close').classList.remove('hidden');   // ← показать крестик
  $('new-char-name').value = '';
  $('name-error').textContent = '';
  renderClassGrid();
  $('modal-classes').classList.add('active');
}

// ------------------------------------------------------------
// ЗАКРЫТИЕ МОДАЛКИ
// ------------------------------------------------------------
$('modal-close').addEventListener('click', closeClassModal);
$('modal-classes').addEventListener('click', e => {
  if (e.target === $('modal-classes')) closeClassModal();
});

function closeClassModal() {
  $('modal-classes').classList.remove('active');
  state.pendingClass = null;
}

// ------------------------------------------------------------
// РЕНДЕР СЕТКИ КЛАССОВ
// ------------------------------------------------------------
function renderClassGrid() {
  const grid = $('class-grid');
  grid.innerHTML = '';
  // Группируем: для классов с двумя ролями (Паладин DPS/SUPPORT) — обе в списке
  for (const cls of state.classes) {
    const opt = document.createElement('div');
    opt.className = 'class-option ' + (cls.role === 'SUPPORT' ? 'support' : 'dps');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'class-icon');
    svg.setAttribute('viewBox', getIconViewBox(cls.icon_id));
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + cls.icon_id);
    svg.appendChild(use);
    
    const label = document.createElement('div');
    label.className = 'class-option-label';
    // Для классов с двумя ролями — добавляем пометку
    const hasBothRoles = state.classes.filter(c => c.name === cls.name).length > 1;
    label.textContent = hasBothRoles ? `${cls.name}` : cls.name;
    
    const roleTag = document.createElement('div');
    roleTag.className = 'class-option-role ' + (cls.role === 'SUPPORT' ? 'support' : 'dps');
    roleTag.textContent = cls.role;
    
    opt.appendChild(svg);
    opt.appendChild(label);
    if (hasBothRoles) opt.appendChild(roleTag);
    
    opt.addEventListener('click', () => selectClass(cls));
    grid.appendChild(opt);
  }
}

// ------------------------------------------------------------
// ВЫБОР КЛАССА → ПЕРЕХОД К ВВОДУ ИМЕНИ
// ------------------------------------------------------------
function selectClass(cls) {
  state.pendingClass = cls;
  $('modal-step-classes').classList.remove('active');
  $('modal-step-name').classList.add('active');
  $('modal-close').classList.add('hidden');   // ← скрыть крестик
  $('new-char-name').value = '';
  $('name-error').textContent = '';
  setTimeout(() => $('new-char-name').focus(), 100);
}

// ------------------------------------------------------------
// СОЗДАНИЕ ПЕРСОНАЖА (локально)
// ------------------------------------------------------------
function createCharacter() {
  const name = $('new-char-name').value.trim();
  if (!name) {
    shakeElement($('new-char-name'), true);
    return;
  }
  // Проверка дубликата в БД
  if (state.characters.some(c => c.name === name)) {
    showNameError('Имя уже зарегистрировано');
    return;
  }
  // Проверка дубликата в локальных
  if (state.draft.inserted.some(c => c.name === name)) {
    showNameError('Имя уже зарегистрировано');
    return;
  }
  
  state.tempIdCounter++;
  state.draft.inserted.push({
    id: 'temp_' + state.tempIdCounter,
    name: name,
    class_id: state.pendingClass.id,
    icon_id: state.pendingClass.icon_id,
    role: state.pendingClass.role,
    classes: {
      id: state.pendingClass.id,
      name: state.pendingClass.name,
      role: state.pendingClass.role,
      icon_id: state.pendingClass.icon_id,
    },
    item_level: 0,   // у нового персонажа ГС = 0 (обновляется автоматически)
    combat_power: 0, // и БС = 0 (обновляется автоматически)
  });
  
  closeClassModal();
  renderCharacters();
  showToast('Персонаж добавлен (не забудьте сохранить)', 'success');
}

function showNameError(text) {
  $('name-error').textContent = text;
  shakeElement($('new-char-name'), true);
}

$('name-send').addEventListener('click', createCharacter);
$('new-char-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    createCharacter();
  }
});

async function loadRaids() {
  const r = await getRaidsInRange();
  if (r.error) { showToast('Не удалось загрузить рейды', 'error'); return; }
  state.raids = r.raids || [];
}

// ------------------------------------------------------------
// РЕНДЕР РАСПИСАНИЯ
// ------------------------------------------------------------
function renderSchedule() {
  const roots = [$('login-schedule-timeline'), $('schedule-timeline')].filter(Boolean);
  if (!roots.length) return;
  const days = [
    {v:3,n:'Среда'}, {v:4,n:'Четверг'}, {v:5,n:'Пятница'},
    {v:6,n:'Суббота'}, {v:7,n:'Воскресенье'},
    {v:1,n:'Понедельник'}, {v:2,n:'Вторник'}
  ];
  const used = days.map(d => ({
    ...d,
    raids: state.raids.filter(r => Number(r.weekday) === d.v)
      .sort((a,b) => (a.start_time || '').localeCompare(b.start_time || ''))
  })).filter(d => d.raids.length);

  for (const root of roots) {
    root.innerHTML = '';
    if (!used.length) {
      root.innerHTML = '<div class="schedule-empty">Расписание пока пустое.</div>';
      continue;
    }
    for (const d of used) {
      const col = document.createElement('section');
      col.className = 'weekday-column';
      const h = document.createElement('h3');
      h.className = 'weekday-title';
      h.textContent = d.n;
      col.appendChild(h);
      const body = document.createElement('div');
      body.className = 'weekday-cards';
      col.appendChild(body);
      for (const raid of d.raids) {
        const card = buildRaidCard(raid);
        const t = document.createElement('div');
        t.className = 'weekday-time';
        t.textContent = (raid.start_time || '20:00').slice(0,5) + ' МСК';
        card.insertBefore(t, card.firstChild);
        body.appendChild(card);
      }
      root.appendChild(col);
    }
  }
}

function formatDayLabel(date) {
  const days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${days[date.getDay()]}, ${date.getDate()} ${months[date.getMonth()]}`;
}

function buildRaidCard(raid) {
  const card = document.createElement('div');
  card.className = 'raid-card';
  card.dataset.raidId = raid.id;

  const rt = raid.raid_types;
  const signupsNow = raid.signups || [];
  const signed = signupsNow.length;
  const max = raid.max_players;
  const isFull = signed >= max;

  // Шапка: название + сложность + счётчик
  const header = document.createElement('div');
  header.className = 'raid-card-header';

  const title = document.createElement('div');
  title.className = 'raid-card-title';
  title.textContent = rt.name;
  if (state.member && (state.member.nickname === 'korozii' || raid.created_by === state.member.id)) {
    title.classList.add('raid-card-title-editable');
    title.title = 'Нажми, чтобы изменить рейд и день';
    title.tabIndex = 0;
    title.setAttribute('role', 'button');
    title.addEventListener('click', e => {
      e.stopPropagation();
      openRaidModal(raid);
    });
    title.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openRaidModal(raid);
      }
    });
  }
  header.appendChild(title);

  const mode = document.createElement('span');
  mode.className = 'raid-card-mode raid-mode-' + rt.mode.toLowerCase();
  mode.textContent = rt.mode;
  header.appendChild(mode);

  const counter = document.createElement('div');
  counter.className = 'raid-card-counter' + (isFull ? ' full' : '');
  counter.textContent = `${signed}/${max}`;
  header.appendChild(counter);

  // Кнопка удаления (если можно)
  if (canDeleteRaid(raid)) {
    const del = document.createElement('button');
    del.className = 'raid-card-delete';
    del.title = 'Удалить рейд';
    del.innerHTML = '✕';
    del.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm(`Удалить рейд «${rt.name} ${rt.mode}»?`)) return;
      const r = await deleteRaid(raid.id);
      if (r.error) {
        showToast('Не удалось удалить рейд', 'error');
        return;
      }
      showToast('Рейд удалён', 'success');
      await loadRaids();
      renderSchedule();
    });
    header.appendChild(del);
  }

  card.appendChild(header);

  // Список записавшихся
  const list = document.createElement('div');
  list.className = 'raid-card-signups';

  for (const s of signupsNow) {
    const row = document.createElement('div');
    row.className = 'raid-signup-row';
    if (state.member && s.member_id === state.member.id) row.classList.add('mine');

    const iconSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    iconSvg.setAttribute('class', 'raid-signup-icon');
    const iconId = s.characters?.classes?.icon_id || 'berserker';
    iconSvg.setAttribute('viewBox', getIconViewBox(iconId));
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + iconId);
    iconSvg.appendChild(use);
    row.appendChild(iconSvg);

    const name = document.createElement('span');
    name.className = 'raid-signup-name';
    name.textContent = s.characters?.name || '???';
    row.appendChild(name);

    const ilvl = document.createElement('span');
    // В расписании показываем БС — окрашиваем его по цвету БС (как в «Мои персонажи»), а не по ГС
    const role = s.characters?.classes?.role || s.characters?.role || 'DPS';
    ilvl.className = 'raid-signup-ilvl ' + (role === 'SUPPORT' ? 'bs-support' : 'bs-dps');
    const cp = s.characters?.combat_power;
    ilvl.textContent = (cp === null || cp === undefined) ? '' : cp; ilvl.title = 'Боевая сила';
    row.appendChild(ilvl);

    // Кнопка удаления записи (свои или админ)
    if (state.member && (s.member_id === state.member.id || state.member.nickname === 'korozii')) {
      const del = document.createElement('button');
      del.className = 'raid-signup-delete';
      del.title = 'Убрать с рейда';
      del.innerHTML = '✕';
      del.addEventListener('click', async e => {
        e.stopPropagation();
        const r = await unsign(s.id);
        if (r.error) {
          showToast('Не удалось убрать', 'error');
          return;
        }
        showToast('Убран с рейда', 'success');
        await loadRaids();
        renderSchedule();
        refreshRaidBoard();
      });
      row.appendChild(del);
    }

    list.appendChild(row);
  }

  card.appendChild(list);

  // Права на удаление рейда
  function canDeleteRaid(raid) {
    if (!state.member) return false;
    if (state.member.nickname === 'korozii') return true;
    if (raid.created_by === state.member.id) {
      // Только если на рейде нет других записей кроме создателя
      const otherSignups = (raid.signups || []).filter(s => s.member_id !== raid.created_by);
      return otherSignups.length === 0;
    }
    return false;
  }

  // Drop-зона
  card.addEventListener('dragover', e => {
    e.preventDefault();
    if (card.classList.contains('drag-over')) return;
    card.classList.add('drag-over');
  });

  card.addEventListener('dragleave', () => {
    card.classList.remove('drag-over');
  });

  card.addEventListener('drop', async e => {
    e.preventDefault();
    if (!state.member) return;
    card.classList.remove('drag-over');

    const charId = e.dataTransfer.getData('text/character-id');
    if (!charId) return;
    const character = state.characters.find(c => c.id === charId);
    if (!character) return;

    // Проверки
    const err = validateSignup(raid, character);
    if (err) {
      showToast(err, 'error');
      return;
    }

    const r = await signup({
      raid_id: raid.id,
      character_id: character.id,
      member_id: state.member.id,
      role: character.classes?.role || 'DPS',
    });

    if (r.error) {
      showToast('Ошибка записи', 'error');
      console.error(r.error);
      return;
    }

    showToast('Записан на рейд', 'success');
    await loadRaids();
    renderSchedule();
    refreshRaidBoard();
  });

  return card;
}

// Валидация записи
function validateSignup(raid, character) {
  const rt = raid.raid_types;
  const signupsNow = raid.signups || [];
  const signed = signupsNow.length;

  // ГС
  if (parseFloat(character.item_level) < parseFloat(rt.required_ilvl)) {
    return `Нужен ГС ${rt.required_ilvl}, у ${character.name} — ${character.item_level}`;
  }

  // Полнота
  if (signed >= raid.max_players) {
    return 'Рейд заполнен';
  }

  // Тот же игрок уже на этом рейде (через любого персонажа)
  const sameMember = (raid.signups || []).some(s => s.member_id === state.member.id);
  if (sameMember) {
    return 'Ты уже записан на этот рейд другим персонажем';
  }

  // Тот же персонаж уже на рейде с таким же name в текущей неделе
  const sameCharOnSameBoss = state.raids.some(r => {
    if (r.raid_types.name !== rt.name) return false;
    return (r.signups || []).some(s => s.character_id === character.id);
  });
  if (sameCharOnSameBoss) {
    return `${character.name} уже записан на ${rt.name}`;
  }

  return null;
}


$('add-raid-btn').addEventListener('click', () => openRaidModal());
$('modal-raid-close')?.addEventListener('click', closeRaidModal);

function closeRaidModal() {
  $('modal-raid').classList.remove('active');
  $('raid-step-1').classList.add('active');
  $('raid-step-2').classList.remove('active');
  $('raid-step-3').classList.remove('active');
  state.pendingRaidType = null;
  state.editingRaidId = null;
}

function openRaidModal(raid = null) {
  state.editingRaidId = raid?.id || null;
  state.selectedRaidWeekday = Number(raid?.weekday || 3);
  if (!raid && $('raid-time-input')) $('raid-time-input').value = '20:00';
  $('modal-raid').classList.add('active');
  $('raid-step-1').classList.add('active');
  $('raid-step-2').classList.remove('active');
  $('raid-step-3').classList.remove('active');
  $('raid-create-btn').textContent = raid ? 'Сохранить изменения' : 'Создать рейд';
  $('raid-time-row')?.classList.toggle('hidden', !!raid);
  renderRaidTypeGrid();
}

function renderRaidTypeGrid() {
  const grid = $('raid-type-grid');
  grid.innerHTML = '';
  const names = [...new Set(state.raidTypes.map(rt => rt.name))];
  for (const name of names) {
    const opt = document.createElement('div');
    opt.className = 'raid-type-option';
    opt.textContent = name;
    opt.addEventListener('click', () => selectRaidType(name));
    grid.appendChild(opt);
  }
}

function selectRaidType(name) {
  state.pendingRaidTypeName = name;
  $('raid-step-1').classList.remove('active');
  $('raid-step-2').classList.add('active');
  const grid = $('raid-mode-grid');
  grid.innerHTML = '';
  for (const rt of state.raidTypes.filter(x => x.name === name)) {
    const opt = document.createElement('div');
    opt.className = 'raid-mode-option raid-mode-' + rt.mode.toLowerCase();
    opt.textContent = rt.mode;
    opt.addEventListener('click', () => selectRaidMode(rt));
    grid.appendChild(opt);
  }
}

function renderWeekdayPicker() {
  const root = $('raid-weekday-picker');
  if (!root) return;
  root.innerHTML = '';
  const days = [
    { value: 3, label: 'Ср' }, { value: 4, label: 'Чт' },
    { value: 5, label: 'Пт' }, { value: 6, label: 'Сб' },
    { value: 7, label: 'Вс' }, { value: 1, label: 'Пн' },
    { value: 2, label: 'Вт' },
  ];
  for (const day of days) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'weekday-choice' + (state.selectedRaidWeekday === day.value ? ' active' : '');
    button.textContent = day.label;
    button.setAttribute('aria-pressed', String(state.selectedRaidWeekday === day.value));
    button.addEventListener('click', () => {
      state.selectedRaidWeekday = day.value;
      renderWeekdayPicker();
    });
    root.appendChild(button);
  }
}

function selectRaidMode(rt) {
  state.pendingRaidType = rt;
  $('raid-step-2').classList.remove('active');
  $('raid-step-3').classList.add('active');
  $('raid-mode-title').textContent = `${rt.name} — ${rt.mode}`;
  $('raid-required-ilvl').textContent = rt.required_ilvl;
  renderWeekdayPicker();
}

$('raid-create-btn').addEventListener('click', async () => {
  if (!state.pendingRaidType || !state.selectedRaidWeekday) {
    showToast('Выбери рейд и день', 'error');
    return;
  }
  if (state.editingRaidId) {
    const r = await updateRaid(state.editingRaidId, {
      raid_type_id: state.pendingRaidType.id,
      weekday: state.selectedRaidWeekday,
      max_players: state.pendingRaidType.size,
    });
    if (r.error) {
      showToast('Не удалось изменить рейд', 'error');
      console.error(r.error);
      return;
    }
    closeRaidModal();
    showToast('Рейд изменён', 'success');
  } else {
    const r = await createRaid({
      raid_type_id: state.pendingRaidType.id,
      weekday: state.selectedRaidWeekday,
      start_time: $('raid-time-input').value || '20:00',
      max_players: state.pendingRaidType.size,
      created_by: state.member.id,
    });
    if (r.error) {
      showToast('Не удалось создать рейд', 'error');
      console.error(r.error);
      return;
    }
    closeRaidModal();
    showToast('Слот добавлен', 'success');
  }
  await loadRaids();
  renderSchedule();
  refreshRaidBoard();
});

const BOARD_KEYS=['Арсенос','Серка','Казерос','Армог'];
function setupTabs(){const nav=$('dragons-tabs');if(!nav)return;nav.querySelectorAll('[data-tab]').forEach(btn=>btn.addEventListener('click',()=>{nav.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x===btn));$('schedule-view').classList.toggle('hidden',btn.dataset.tab!=='schedule');$('raids-view').classList.toggle('hidden',btn.dataset.tab!=='raids');if(btn.dataset.tab==='raids'){if(!raidBoardLoaded||raidBoardDirty)loadRaidBoard();}}));}
function normalIlvl(key){const list=state.raidTypes.filter(x=>x.name===key);return Number((list.find(x=>/normal|обыч/i.test(x.mode))||list[0])?.required_ilvl||Infinity);}
// ------------------------------------------------------------
// ТАБЛИЧКА РЕЙДОВ
// Таблица строится один раз, дальше только точечно обновляется.
// Полная перезагрузка (loadRaidBoard) вызывается лишь при реальной
// смене данных или когда вкладка скрыта и её всё равно никто не видит.
// ------------------------------------------------------------
let raidBoardLoaded = false;   // таблица сейчас отрисована
let raidBoardDirty  = false;   // данные устарели — перерисовать при открытии вкладки

function isRaidBoardVisible() {
  const view = $('raids-view');
  return !!view && !view.classList.contains('hidden');
}

// Аккуратная перерисовка: если вкладка видна — рисуем, иначе помечаем грязной
function refreshRaidBoard() {
  if (isRaidBoardVisible()) loadRaidBoard();
  else { raidBoardLoaded = false; raidBoardDirty = true; }
}

// Синхронизация таблички с изменениями персонажей (ГС/БС/имя/состав)
let boardSyncTimer = null;
function syncRaidBoardWithCharacters() {
  // Табличка ещё не отрисована (вкладка рейдов была закрыта) — просто помечаем
  // её грязной: при открытии вкладки она загрузится уже в актуальном порядке.
  // Никаких рекурсивных вызовов loadRaidBoard() отсюда — иначе перерисовка
  // списка и таблички зацикливали друг друга и список «не обновлялся».
  if (!raidBoardLoaded) { raidBoardDirty = true; return; }
  clearTimeout(boardSyncTimer);
  boardSyncTimer = setTimeout(() => {
    const body = $('raid-board-body');
    if (!body || !isRaidBoardVisible()) { raidBoardLoaded = false; raidBoardDirty = true; return; }
    // Состав строк изменился (добавили/удалили персонажа) — нужна полная перерисовка
    const rowIds = [...body.querySelectorAll('tr[data-id]')].map(x => x.dataset.id);
    const charIds = sortedCharacters().map(c => String(c.id));
    if (rowIds.length !== charIds.length || charIds.some(id => !rowIds.includes(id))) {
      loadRaidBoard();
      return;
    }
    // Порядок в табличке разошёлся с sort_order (например, меняли списком) — перестроить строки
    if (rowIds.some((id, i) => id !== charIds[i])) {
      for (const id of charIds) body.appendChild(body.querySelector('tr[data-id="' + id + '"]'));
    }
    // Иначе обновляем ячейки на месте — без перезагрузки и дёрганья
    for (const ch of state.characters) {
      const tr = body.querySelector('tr[data-id="' + ch.id + '"]');
      if (!tr) continue;
      const nameEl = tr.querySelector('.board-character');
      if (nameEl && nameEl.textContent !== ch.name) nameEl.textContent = ch.name;
      const cells = [...tr.querySelectorAll('td.progress-cell')];
      BOARD_KEYS.forEach((key, i) => {
        const btn = cells[i]?.querySelector('.progress-toggle');
        if (!btn || btn.matches(':hover,:active')) return; // не мешаем клику
        updateProgressButton(btn, ch, key);
      });
      tr.classList.toggle('all-done', BOARD_KEYS.every(k => doneMarks.get(ch.id + '|' + k) === true));
    }
  }, 250);
}

// Состояние кнопок отметок для персонажа по конкретному рейду
function progressBtnState(ch, key) {
  const doneNow = doneMarks.get(ch.id + '|' + key) === true;
  const isSigned = signedChars.has(ch.id + '|' + key);
  const can = Number(ch.item_level || 0) >= normalIlvl(key);
  return {
    can, doneNow,
    cls: 'progress-toggle ' + (!can ? 'blocked' : doneNow ? 'done' : isSigned ? 'signed' : 'empty'),
    text: !can ? '×' : doneNow ? '✓' : isSigned ? '−' : '',
    title: !can ? 'Недостаточный ГС' : doneNow ? 'Снять отметку' : 'Отметить выполнение',
  };
}

function updateProgressButton(btn, ch, key) {
  const st = progressBtnState(ch, key);
  btn.className = st.cls;
  btn.textContent = st.text;
  btn.title = st.title;
  btn.disabled = !st.can;
}

const doneMarks   = new Map(); // character_id|raid_key -> completed
const signedChars = new Set(); // character_id|raid_key

async function loadRaidBoard() {
  const body = $('raid-board-body');
  if (!body || !state.member) return;
  raidBoardLoaded = true;
  raidBoardDirty = false;
  body.innerHTML = '';
  const ids = state.characters.map(c => c.id);
  let progress = [];
  if (ids.length) {
    const q = await dragonsSupabase.from('character_raid_progress').select('character_id,raid_key,completed').in('character_id', ids);
    if (q.error) { body.innerHTML = '<tr><td colspan="6">Ошибка загрузки отметок. Проверь RLS таблицы прогресса.</td></tr>'; return; }
    progress = q.data || [];
  }
  doneMarks.clear();
  for (const p of progress) doneMarks.set(p.character_id + '|' + p.raid_key, p.completed);
  signedChars.clear();
  for (const r of state.raids) for (const s of r.signups || []) if (s.member_id === state.member.id) signedChars.add(s.character_id + '|' + (r.raid_types?.name));

  const chars = sortedCharacters(); // тот же порядок, что и в списке «Мои персонажи»
  // Нормализуем sort_order в памяти по фактическому порядку (i+1), чтобы он
  // всегда совпадал с табличкой. В БД пишем только явно новые значения порядка
  // (после drag&drop drop-обработчик сохраняет сам) — здесь не трогаем БД,
  // иначе лишние записи перезаписывают результат перетаскивания.
  for (let i = 0; i < chars.length; i++) {
    if (Number(chars[i].sort_order) !== i + 1) chars[i].sort_order = i + 1;
  }
  for (const ch of chars) {
    const tr = document.createElement('tr');
    tr.draggable = true;
    tr.dataset.id = ch.id;

    const name = document.createElement('td');
    name.className = 'board-character';
    name.textContent = ch.name;
    tr.appendChild(name);

    const coinCell = document.createElement('td');
    const coin = document.createElement('button');
    coin.className = 'coin-toggle' + (ch.gold_coin_active === false ? ' muted' : '');
    coin.textContent = '◉';
    coin.title = 'Сбор золота';
    coin.onclick = async () => {
      const v = ch.gold_coin_active === false;
      const { error } = await dragonsSupabase.from('characters').update({ gold_coin_active: v }).eq('id', ch.id);
      if (error) { showToast('Не удалось сохранить', 'error'); return; }
      ch.gold_coin_active = v;
      coin.classList.toggle('muted', !v); // без перезагрузки таблички
    };
    coinCell.appendChild(coin);
    tr.appendChild(coinCell);

    let all = true;
    for (const key of BOARD_KEYS) {
      const td = document.createElement('td');
      td.className = 'progress-cell';
      const btn = document.createElement('button');
      updateProgressButton(btn, ch, key);
      if (doneMarks.get(ch.id + '|' + key) !== true) all = false;
      btn.onclick = async () => {
        const nowDone = doneMarks.get(ch.id + '|' + key) === true;
        const next = !nowDone;
        // Оптимистично меняем только эту кнопку — табличка не перезагружается
        doneMarks.set(ch.id + '|' + key, next);
        updateProgressButton(btn, ch, key);
        tr.classList.toggle('all-done', BOARD_KEYS.every(k => doneMarks.get(ch.id + '|' + k) === true));
        const { error } = await dragonsSupabase.from('character_raid_progress')
          .upsert({ character_id: ch.id, raid_key: key, completed: next, updated_at: new Date().toISOString() }, { onConflict: 'character_id,raid_key' });
        if (error) {
          showToast('Не удалось сохранить отметку', 'error');
          doneMarks.set(ch.id + '|' + key, nowDone); // откат
          updateProgressButton(btn, ch, key);
          tr.classList.toggle('all-done', BOARD_KEYS.every(k => doneMarks.get(ch.id + '|' + k) === true));
        }
      };
      td.appendChild(btn);
      tr.appendChild(td);
    }
    if (all) tr.classList.add('all-done');

    tr.addEventListener('dragstart', e => { e.dataTransfer.setData('text/dragon-character', ch.id); tr.classList.add('dragging'); });
    tr.addEventListener('dragend', () => tr.classList.remove('dragging'));
    tr.addEventListener('dragover', e => e.preventDefault());
    tr.addEventListener('drop', async e => {
      e.preventDefault();
      // Тащим карточку из списка «Мои персонажи»? (другой MIME, чем у строк таблички)
      const fromList = e.dataTransfer.getData('text/character-id');
      if (fromList) return; // перестановка списком здесь не нужна — игнорируем
      const moving = e.dataTransfer.getData('text/dragon-character');
      if (!moving || String(moving) === String(ch.id)) return;
      const order = [...body.querySelectorAll('tr[data-id]')].map(x => x.dataset.id);
      const a = order.indexOf(String(moving)), z = order.indexOf(String(ch.id));
      if (a < 0 || z < 0) return;
      order.splice(z, 0, order.splice(a, 1)[0]);

      // 1. Применяем новый порядок СРАЗУ и локально, не дожидаясь ответа БД:
      //    перестраиваем строки таблички в DOM
      for (const id of order) body.appendChild(body.querySelector('tr[data-id="' + id + '"]'));
      //    обновляем sort_order в памяти по новому порядку
      for (let i = 0; i < order.length; i++) {
        const c = state.characters.find(x => String(x.id) === order[i]);
        if (c) c.sort_order = i + 1;
      }
      // 2. Перерисовываем список «Мои персонажи» в новом порядке
      //    (sortedCharacters() уже учитывает обновлённый sort_order)
      renderCharacters();
      raidBoardDirty = false;

      // 3. Сохраняем порядок в БД в фоне; при ошибке ничего не откатываем —
      //    локальный порядок остаётся, а при следующей загрузке таблички он
      //    будет зафиксирован заново
      for (let i = 0; i < order.length; i++) {
        await dragonsSupabase.from('characters').update({ sort_order: i + 1 }).eq('id', order[i]);
      }
    });
    body.appendChild(tr);
  }
}

setupTabs();

// ------------------------------------------------------------
// СТАРТ
// ------------------------------------------------------------
init();