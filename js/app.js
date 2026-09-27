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
  deleteRaid,
  signup,
  unsign,
  getRaidTypes,
} from './api.js';

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
  tempIdCounter: 0,

  // НОВОЕ:
  raids: [],              // рейды текущей недели
  raidTypes: [],          // справочник рейдов из БД
  weekStart: null,        // Date начала недели (среда 6:00 МСК)
  weekEnd: null,          // Date конца недели
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
  await loadRaids();
  renderCharacters();
  renderSchedule();
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
// РЕНДЕР СПИСКА ПЕРСОНАЖЕЙ
// ------------------------------------------------------------
function renderCharacters() {
  const list = $('characters-list');
  list.innerHTML = '';
  // Существующие персонажи
  for (const ch of state.characters) {
    list.appendChild(buildCharCard(ch, false));
  }
  // Локально созданные (ещё не в БД)
  for (const ch of state.draft.inserted) {
    list.appendChild(buildCharCard(ch, true));
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
  setupCharacterDrag();
}

// ------------------------------------------------------------
// ПОСТРОЕНИЕ КАРТОЧКИ ПЕРСОНАЖА
// ------------------------------------------------------------
function buildCharCard(ch, isNew) {
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
  const nameEl = document.createElement('div');
  nameEl.className = 'char-name';
  nameEl.textContent = ch.name;
  
  const stats = document.createElement('div');
  stats.className = 'char-stats';
  const role = ch.classes?.role || ch.role || 'DPS';
  
  // GS
  const gsWrap = document.createElement('span');
  if (state.editMode && !state.draft.deleted.has(ch.id)) {
    const gsInput = document.createElement('input');
    gsInput.type = 'number';
    gsInput.className = 'stat-input';
    gsInput.value = ch.item_level;
    gsInput.step = '0.01';
    gsInput.min = '0';
    gsInput.addEventListener('input', () => {
      const val = parseFloat(gsInput.value) || 0;
      if (isNew) {
        ch.item_level = val;
      } else {
        state.draft.updated[ch.id] = state.draft.updated[ch.id] || {
          id: ch.id,
          item_level: ch.item_level,
          combat_power: ch.combat_power,
        };
        state.draft.updated[ch.id].item_level = val;
      }
    });
    gsWrap.appendChild(gsInput);
  } else {
    gsWrap.className = getGsClass(ch.item_level);
    gsWrap.textContent = ch.item_level;
  }
  
  // BS
  const bsWrap = document.createElement('span');
  if (state.editMode && !state.draft.deleted.has(ch.id)) {
    const bsInput = document.createElement('input');
    bsInput.type = 'number';
    bsInput.className = 'stat-input';
    bsInput.value = ch.combat_power;
    bsInput.min = '0';
    bsInput.addEventListener('input', () => {
      const val = parseInt(bsInput.value) || 0;
      if (isNew) {
        ch.combat_power = val;
      } else {
        state.draft.updated[ch.id] = state.draft.updated[ch.id] || {
          id: ch.id,
          item_level: ch.item_level,
          combat_power: ch.combat_power,
        };
        state.draft.updated[ch.id].combat_power = val;
      }
    });
    bsWrap.appendChild(bsInput);
  } else {
    bsWrap.className = role === 'SUPPORT' ? 'bs-support' : 'bs-dps';
    bsWrap.textContent = ch.combat_power;
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
  const inserted = state.draft.inserted.map(c => ({
    name: c.name,
    class_id: c.class_id,
    item_level: c.item_level || 0,
    combat_power: c.combat_power || 0,
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
    item_level: 0,
    combat_power: 0,
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

// ------------------------------------------------------------
// НЕДЕЛЯ: границы (среда 6:00 МСК)
// ------------------------------------------------------------
const MSK_TIME_ZONE = 'Europe/Moscow';

function getMskParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MSK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const out = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

// Преобразует дату/время, введённые как МСК, в настоящий UTC Date.
function mskDateTimeToUtc(dateString, timeString) {
  const [year, month, day] = dateString.split('-').map(Number);
  const [hour, minute] = timeString.split(':').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour - 3, minute, 0));
}

function getWeekBounds(date = new Date()) {
  const msk = getMskParts(date);
  // 0=Вс, 1=Пн, 2=Вт, 3=Ср...
  const wallClock = new Date(Date.UTC(msk.year, msk.month - 1, msk.day, msk.hour, msk.minute, msk.second));
  const day = wallClock.getUTCDay();

  let daysBack;
  if (day === 3 && msk.hour >= 6) {
    daysBack = 0;
  } else if (day === 3 && msk.hour < 6) {
    daysBack = 7;
  } else if (day > 3) {
    daysBack = day - 3;
  } else {
    daysBack = day + 4;
  }

  const startWall = new Date(wallClock);
  startWall.setUTCDate(startWall.getUTCDate() - daysBack);
  startWall.setUTCHours(6, 0, 0, 0);

  // startWall — это «настенные» часы МСК, поэтому отнимаем UTC+3.
  const startUtc = new Date(startWall.getTime() - 3 * 60 * 60 * 1000);
  const endUtc = new Date(startUtc.getTime() + 7 * 24 * 60 * 60 * 1000);

  return { start: startUtc, end: endUtc };
}

async function loadRaids() {
  const { start, end } = getWeekBounds();
  state.weekStart = start;
  state.weekEnd = end;

  const r = await getRaidsInRange(start.toISOString(), end.toISOString());
  if (r.error) {
    console.error('getRaidsInRange:', r.error);
    showToast('Не удалось загрузить рейды', 'error');
    state.raids = [];
    return;
  }
  state.raids = r.raids || [];
}

// ------------------------------------------------------------
// РЕНДЕР РАСПИСАНИЯ
// ------------------------------------------------------------
function formatMskDateTime(date) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: MSK_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function formatDayLabel(date) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: MSK_TIME_ZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(date).replace(',', '');
}

function getMskDateKey(date) {
  const p = getMskParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function getRaidDeletePermission(raid) {
  // Администратор korozii может удалить любой рейд.
  if (state.member?.nickname === 'korozii') return true;

  // Создатель может удалить рейд только если кроме него никого нет.
  if (raid.created_by !== state.member?.id) return false;
  return !(raid.signups || []).some(s => s.member_id !== raid.created_by);
}

function renderSchedule() {
  const container = $('schedule-timeline');
  if (!container) return;
  destroyRaidSortables();
  container.innerHTML = '';

  if (state.raids.length === 0) {
    container.innerHTML = '<div class="schedule-empty">На эту неделю рейды не запланированы</div>';
    return;
  }

  // День = колонка. Пустые дни вообще не создаём.
  const byDay = new Map();
  for (const raid of state.raids) {
    const key = getMskDateKey(new Date(raid.datetime));
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(raid);
  }

  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // Вертикальный масштаб: 1 час = 100px. Карточки остаются отдельными «стикерами».
  const PX_PER_MINUTE = 100 / 60;
  const CARD_GAP = 10;
  const DAY_TOP = 48;

  const board = document.createElement('div');
  board.className = 'schedule-board';

  for (const [, raids] of days) {
    raids.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

    const column = document.createElement('div');
    column.className = 'schedule-day-column';

    const dayHeader = document.createElement('div');
    dayHeader.className = 'schedule-day-header';
    dayHeader.textContent = formatDayLabel(new Date(raids[0].datetime));
    column.appendChild(dayHeader);

    const track = document.createElement('div');
    track.className = 'schedule-day-track';

    // Не рисуем пустую область до первого рейда. Время между рейдами сохраняется.
    let cursorBottom = 0;
    for (const raid of raids) {
      const dt = new Date(raid.datetime);
      const msk = getMskParts(dt);
      const minutes = msk.hour * 60 + msk.minute;
      const firstMsk = getMskParts(new Date(raids[0].datetime));
      const firstMinutes = firstMsk.hour * 60 + firstMsk.minute;
      const naturalTop = (minutes - firstMinutes) * PX_PER_MINUTE;
      const top = Math.max(naturalTop, cursorBottom);

      const card = buildRaidCard(raid);
      card.style.top = `${top}px`;
      track.appendChild(card);

      // Реальная высота карточки станет известна после добавления в DOM.
      // Берём минимальную оценку, чтобы близкие рейды не накладывались.
      cursorBottom = top + 118 + CARD_GAP;
    }

    // Добавляем немного воздуха снизу, но не создаём часовую сетку.
    const last = track.lastElementChild;
    const trackHeight = last ? last.offsetTop + last.offsetHeight + 18 : 80;
    track.style.minHeight = `${Math.max(trackHeight, 90)}px`;

    column.appendChild(track);
    board.appendChild(column);
  }

  container.appendChild(board);
}

function buildRaidCard(raid) {
  const card = document.createElement('div');
  card.className = 'raid-card';
  card.dataset.raidId = raid.id;

  const rt = raid.raid_types || {};
  const signups = raid.signups || [];
  const signed = signups.length;
  const max = Number(raid.max_players) || Number(rt.size) || 0;
  const isFull = max > 0 && signed >= max;

  // Шапка рейда.
  const header = document.createElement('div');
  header.className = 'raid-card-header';

  const title = document.createElement('div');
  title.className = 'raid-card-title';
  title.textContent = rt.name || 'Рейд';
  header.appendChild(title);

  const mode = document.createElement('span');
  mode.className = 'raid-card-mode raid-mode-' + String(rt.mode || '').toLowerCase();
  mode.textContent = rt.mode || '—';
  header.appendChild(mode);

  const counter = document.createElement('div');
  counter.className = 'raid-card-counter' + (isFull ? ' full' : '');
  counter.textContent = `${signed}/${max}`;
  header.appendChild(counter);

  const deleteAllowed = getRaidDeletePermission(raid);
  if (deleteAllowed) {
    const del = document.createElement('button');
    del.className = 'raid-card-delete';
    del.title = 'Удалить рейд';
    del.innerHTML = '✕';
    del.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm(`Удалить рейд «${rt.name || 'Рейд'} ${rt.mode || ''}»?`)) return;

      const r = await deleteRaid(raid.id);
      if (r.error) {
        console.error('deleteRaid:', r.error);
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

  // Время показываем в самой карточке, чтобы было понятно и без постоянной оси.
  const time = document.createElement('div');
  time.className = 'raid-card-time';
  time.textContent = formatMskDateTime(new Date(raid.datetime)) + ' МСК';
  card.appendChild(time);

  const list = document.createElement('div');
  list.className = 'raid-card-signups';

  for (const s of signups) {
    const row = document.createElement('div');
    row.className = 'raid-signup-row' + (s.member_id === state.member.id ? ' mine' : '');
    row.dataset.signupId = s.id;

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
    ilvl.className = 'raid-signup-ilvl ' + getGsClass(s.characters?.item_level);
    ilvl.textContent = s.characters?.item_level ?? '—';
    row.appendChild(ilvl);

    const canRemoveSignup = s.member_id === state.member.id || state.member.nickname === 'korozii';
    if (canRemoveSignup) {
      const del = document.createElement('button');
      del.className = 'raid-signup-delete';
      del.title = 'Убрать с рейда';
      del.innerHTML = '✕';
      del.addEventListener('click', async e => {
        e.preventDefault();
        e.stopPropagation();
        const r = await unsign(s.id);
        if (r.error) {
          console.error('unsign:', r.error);
          showToast('Не удалось убрать персонажа', 'error');
          return;
        }
        showToast('Персонаж убран с рейда', 'success');
        await loadRaids();
        renderSchedule();
      });
      row.appendChild(del);
    }

    list.appendChild(row);
  }

  card.appendChild(list);

  // SortableJS: вся карточка — drop-зона, но перетаскивать из рейда ничего нельзя.
  setupRaidDrop(card, raid);
  return card;
}

function validateSignup(raid, character) {
  const rt = raid.raid_types || {};
  const signed = raid.signups?.length || 0;
  const requiredIlvl = Number(rt.required_ilvl) || 0;
  const characterIlvl = Number(character.item_level) || 0;

  if (signed >= Number(raid.max_players || rt.size || 0)) {
    return 'Рейд заполнен';
  }

  // Ограничение ГС.
  if (characterIlvl < requiredIlvl) {
    return `Нужен ГС ${requiredIlvl}, у ${character.name} — ${character.item_level}`;
  }

  // На конкретный рейд — только один персонаж одного участника.
  const sameMember = (raid.signups || []).some(s => s.member_id === state.member.id);
  if (sameMember) {
    return 'Ты уже записан на этот рейд другим персонажем';
  }

  // Один и тот же персонаж не может ходить на один и тот же boss name дважды в неделю.
  const bossName = String(rt.name || '').trim().toLowerCase();
  const sameCharOnSameBoss = state.raids.some(r => {
    const otherName = String(r.raid_types?.name || '').trim().toLowerCase();
    return otherName === bossName && (r.signups || []).some(s => s.character_id === character.id);
  });

  if (sameCharOnSameBoss) {
    return `${character.name} уже записан на ${rt.name} на этой неделе`;
  }

  return null;
}

// ------------------------------------------------------------
// DRAG & DROP / SORTABLE.JS
// ------------------------------------------------------------
let raidSortables = [];

function destroyRaidSortables() {
  for (const sortable of raidSortables) {
    try { sortable.destroy(); } catch {}
  }
  raidSortables = [];
}

function setupCharacterDrag() {
  if (typeof Sortable === 'undefined') {
    console.warn('SortableJS не загружен');
    return;
  }

  const list = $('characters-list');
  if (list._raidSortable) {
    list._raidSortable.destroy();
    list._raidSortable = null;
  }

  list._raidSortable = new Sortable(list, {
    group: {
      name: 'raid-signup',
      pull: 'clone',
      put: false,
    },
    sort: false,
    animation: 150,
    draggable: '.char-card',
    ghostClass: 'char-drag-ghost',
    chosenClass: 'char-drag-chosen',
    fallbackOnBody: true,
    touchStartThreshold: 6,
    onStart: evt => {
      const id = evt.item?.dataset?.charId;
      state.draggingCharacter = state.characters.find(c => c.id === id) || null;
    },
    onEnd: () => {
      state.draggingCharacter = null;
    },
  });
}

function setupRaidDrop(card, raid) {
  if (typeof Sortable === 'undefined') return;

  const sortable = new Sortable(card, {
    group: {
      name: 'raid-signup',
      pull: false,
      put: true,
    },
    sort: false,
    animation: 120,
    draggable: '.char-card',
    fallbackOnBody: true,
    onAdd: async evt => {
      // Sortable добавил clone в карточку. Сразу удаляем его: фактическое состояние только БД.
      const charId = evt.item?.dataset?.charId || state.draggingCharacter?.id;
      evt.item?.remove();
      card.classList.remove('drag-over');
      const character = state.characters.find(c => c.id === charId);
      if (!character) return;

      const err = validateSignup(raid, character);
      if (err) {
        shakeElement(card, true);
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
        console.error('signup:', r.error);
        showToast('Ошибка записи на рейд', 'error');
        return;
      }

      showToast('Персонаж записан на рейд', 'success');
      await loadRaids();
      renderSchedule();
    },
    onMove: () => true,
  });

  raidSortables.push(sortable);
}

// ------------------------------------------------------------
// МОДАЛКА СОЗДАНИЯ РЕЙДА
// ------------------------------------------------------------
$('add-raid-btn').addEventListener('click', openRaidModal);
$('modal-raid-close').addEventListener('click', closeRaidModal);
$('modal-raid').addEventListener('click', e => {
  if (e.target === $('modal-raid')) closeRaidModal();
});

function closeRaidModal() {
  $('modal-raid').classList.remove('active');
  $('raid-step-1').classList.add('active');
  $('raid-step-2').classList.remove('active');
  $('raid-step-3').classList.remove('active');
  state.pendingRaidType = null;
  state.pendingRaidTypeName = null;
}

function openRaidModal() {
  $('modal-raid').classList.add('active');
  $('raid-step-1').classList.add('active');
  $('raid-step-2').classList.remove('active');
  $('raid-step-3').classList.remove('active');
  state.pendingRaidType = null;
  state.pendingRaidTypeName = null;
  renderRaidTypeGrid();
}

function renderRaidTypeGrid() {
  const grid = $('raid-type-grid');
  grid.innerHTML = '';

  const names = [...new Set(state.raidTypes.map(rt => rt.name).filter(Boolean))];
  if (names.length === 0) {
    grid.innerHTML = '<div class="schedule-empty">Не удалось загрузить типы рейдов</div>';
    return;
  }

  for (const name of names) {
    const opt = document.createElement('button');
    opt.type = 'button';
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
  const modes = state.raidTypes.filter(rt => rt.name === name);

  for (const rt of modes) {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'raid-mode-option raid-mode-' + String(rt.mode || '').toLowerCase();
    opt.innerHTML = `<strong>${rt.mode || '—'}</strong><span>ГС ${rt.required_ilvl ?? '—'} · ${rt.size ?? '—'} чел.</span>`;
    opt.addEventListener('click', () => selectRaidMode(rt));
    grid.appendChild(opt);
  }
}

function selectRaidMode(rt) {
  state.pendingRaidType = rt;
  $('raid-step-2').classList.remove('active');
  $('raid-step-3').classList.add('active');

  $('raid-mode-title').textContent = `${rt.name} — ${rt.mode}`;
  $('raid-required-ilvl').textContent = rt.required_ilvl ?? '—';

  const now = new Date();
  const msk = getMskParts(now);
  const today = `${msk.year}-${String(msk.month).padStart(2, '0')}-${String(msk.day).padStart(2, '0')}`;
  $('raid-date-input').min = today;
  $('raid-date-input').value = today;

  // Округляем текущее время вверх до ближайших 30 минут.
  let minute = msk.minute < 30 ? 30 : 60;
  let hour = msk.hour + (minute === 60 ? 1 : 0);
  if (hour >= 24) {
    const tomorrow = new Date(Date.UTC(msk.year, msk.month - 1, msk.day) + 86400000);
    const y = tomorrow.getUTCFullYear();
    const mo = String(tomorrow.getUTCMonth() + 1).padStart(2, '0');
    const d = String(tomorrow.getUTCDate()).padStart(2, '0');
    $('raid-date-input').value = `${y}-${mo}-${d}`;
    hour = 0;
  }
  $('raid-time-input').value = `${String(hour).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

$('raid-create-btn').addEventListener('click', async () => {
  if (!state.pendingRaidType) {
    showToast('Сначала выбери рейд и сложность', 'error');
    return;
  }

  const date = $('raid-date-input').value;
  const time = $('raid-time-input').value;
  if (!date || !time) {
    showToast('Выбери дату и время', 'error');
    return;
  }

  const dt = mskDateTimeToUtc(date, time);
  if (dt.getTime() <= Date.now()) {
    showToast('Нельзя создать рейд в прошлом', 'error');
    return;
  }

  const r = await createRaid({
    raid_type_id: state.pendingRaidType.id,
    datetime: dt.toISOString(),
    max_players: Number(state.pendingRaidType.size),
    created_by: state.member.id,
  });

  if (r.error) {
    console.error('createRaid:', r.error);
    showToast('Не удалось создать рейд', 'error');
    return;
  }

  closeRaidModal();
  showToast('Рейд создан', 'success');
  await loadRaids();
  renderSchedule();
});

// ------------------------------------------------------------
// СТАРТ
// ------------------------------------------------------------
init();
