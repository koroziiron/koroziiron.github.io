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
  supabase as dragonsSupabase,
} from './api.js';
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
  tempIdCounter: 0,

  // НОВОЕ:
  raids: [],              // рейды текущей недели
  raidTypes: [],          // справочник рейдов из БД
  weekStart: null,        // Date начала недели (среда 6:00 МСК)
  weekEnd: null,          // Date конца недели
  draggingCharacter: null,// персонаж, которого тащат
  draggingId: null,       // id персонажа (строка), который тащат в таблице рейдов
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
    state.draggingId = String(ch.id);
    e.dataTransfer.setData('text/plain', String(ch.id));
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => {
    state.draggingCharacter = null;
    state.draggingId = null;
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
  
  // Пустые значения ГС/БС (null / undefined / '') показываем как пустое поле, а не 0
  const hasGs = ch.item_level !== null && ch.item_level !== undefined && String(ch.item_level).trim() !== '';
  const hasBs = ch.combat_power !== null && ch.combat_power !== undefined && String(ch.combat_power).trim() !== '';

  // GS
  const gsWrap = document.createElement('span');
  if (state.editMode && !state.draft.deleted.has(ch.id)) {
    const gsInput = document.createElement('input');
    gsInput.type = 'number';
    gsInput.className = 'stat-input';
    gsInput.value = hasGs ? ch.item_level : '';
    gsInput.placeholder = 'ГС';
    gsInput.step = '0.01';
    gsInput.min = '0';
    gsInput.addEventListener('input', () => {
      const rawGs = gsInput.value.trim();
      const val = rawGs === '' ? null : parseFloat(rawGs);
      if (rawGs !== '' && isNaN(val)) return;
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
    gsWrap.textContent = hasGs ? ch.item_level : '';
  }
  
  // BS
  const bsWrap = document.createElement('span');
  if (state.editMode && !state.draft.deleted.has(ch.id)) {
    const bsInput = document.createElement('input');
    bsInput.type = 'number';
    bsInput.className = 'stat-input';
    bsInput.value = hasBs ? ch.combat_power : '';
    bsInput.placeholder = 'БС';
    bsInput.min = '0';
    bsInput.addEventListener('input', () => {
      const rawBs = bsInput.value.trim();
      const val = rawBs === '' ? null : parseInt(rawBs);
      if (rawBs !== '' && isNaN(val)) return;
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
  const inserted = state.draft.inserted.map(c => ({
    name: c.name,
    class_id: c.class_id,
    item_level: c.item_level ?? null,
    combat_power: c.combat_power ?? null,
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
    item_level: null,   // пустые поля ГС/БС у нового персонажа
    combat_power: null,
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
function getWeekBounds(date = new Date()) {
  // Приводим к МСК
  const mskOffset = 3 * 60; // минуты
  const local = new Date(date.getTime() + (date.getTimezoneOffset() + mskOffset) * 60000);

  const day = local.getDay(); // 0=Вс, 1=Пн, ..., 3=Ср
  const hour = local.getHours();

  // Определяем, сколько дней назад была среда 6:00
  let daysBack;
  if (day === 3 && hour >= 6) {
    daysBack = 0;
  } else if (day === 3 && hour < 6) {
    daysBack = 7;
  } else if (day > 3) {
    daysBack = day - 3;
  } else {
    daysBack = day + 4;
  }

  const start = new Date(local);
  start.setDate(start.getDate() - daysBack);
  start.setHours(6, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 7);

  // Возвращаем в UTC для запросов в БД
  const startUtc = new Date(start.getTime() - mskOffset * 60000);
  const endUtc = new Date(end.getTime() - mskOffset * 60000);

  return { start: startUtc, end: endUtc };
}

async function loadRaids() {
  const r = await getRaidsInRange();
  if (r.error) { showToast('Не удалось загрузить рейды', 'error'); return; }
  state.raids = r.raids || [];
}

// ------------------------------------------------------------
// РЕНДЕР РАСПИСАНИЯ
// ------------------------------------------------------------
function renderSchedule() {
 const root=$('schedule-timeline'); if(!root)return; root.innerHTML='';
 const days=[{v:3,n:'Среда'},{v:4,n:'Четверг'},{v:5,n:'Пятница'},{v:6,n:'Суббота'},{v:7,n:'Воскресенье'},{v:1,n:'Понедельник'},{v:2,n:'Вторник'}];
 const used=days.map(d=>({...d,raids:state.raids.filter(r=>Number(r.weekday)===d.v).sort((a,b)=>(a.start_time||'').localeCompare(b.start_time||''))})).filter(d=>d.raids.length);
 if(!used.length){root.innerHTML='<div class="schedule-empty">Расписание пока пустое. Создай первый рейд.</div>';return;}
 for(const d of used){const col=document.createElement('section');col.className='weekday-column';const h=document.createElement('h3');h.className='weekday-title';h.textContent=d.n;col.appendChild(h);for(const raid of d.raids){const card=buildRaidCard(raid);const t=document.createElement('div');t.className='weekday-time';t.textContent=(raid.start_time||'20:00').slice(0,5)+' МСК';card.insertBefore(t,card.firstChild);col.appendChild(card);}root.appendChild(col);}
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
  const weekSignups = (raid.signups || []).filter(s => s.week_start === weekStartDate());
  const signed = weekSignups.length;
  const max = raid.max_players;
  const isFull = signed >= max;

  // Шапка: название + сложность + счётчик
  const header = document.createElement('div');
  header.className = 'raid-card-header';

  const title = document.createElement('div');
  title.className = 'raid-card-title';
  title.textContent = rt.name;
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

  for (const s of weekSignups) {
    const row = document.createElement('div');
    row.className = 'raid-signup-row';
    if (s.member_id === state.member.id) row.classList.add('mine');

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
    const cp = s.characters?.combat_power;
    ilvl.textContent = (cp === null || cp === undefined) ? '' : cp; ilvl.title = 'Боевая сила';
    row.appendChild(ilvl);

    // Кнопка удаления записи (свои или админ)
    if (s.member_id === state.member.id || state.member.nickname === 'korozii') {
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
      });
      row.appendChild(del);
    }

    list.appendChild(row);
  }

  card.appendChild(list);

  // Права на удаление рейда
  function canDeleteRaid(raid) {
    if (state.member.nickname === 'korozii') return true;
    if (raid.created_by === state.member.id) {
      // Только если на рейде нет других записей кроме создателя
      const otherSignups = (raid.signups || []).filter(s => s.week_start === weekStartDate() && s.member_id !== raid.created_by);
      return otherSignups.length === 0;
    }
    return false;
  }

  // Drop-зона
  card.addEventListener('dragenter', e => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('text/plain')) return;
    e.preventDefault();
    card.classList.add('drag-over');
  });

  card.addEventListener('dragover', e => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('text/plain')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    card.classList.add('drag-over');
  });

  card.addEventListener('dragleave', e => {
    if (e.relatedTarget && card.contains(e.relatedTarget)) return;
    card.classList.remove('drag-over');
  });

  card.addEventListener('drop', async e => {
    e.preventDefault();
    card.classList.remove('drag-over');

    const charId = e.dataTransfer.getData('text/plain') || state.draggingId;
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
      week_start: weekStartDate(),
      raid_key: raid.raid_types.name,
    });

    if (r.error) {
      showToast('Ошибка записи', 'error');
      console.error(r.error);
      return;
    }

    showToast('Записан на рейд', 'success');
    await loadRaids();
    renderSchedule();
  });

  return card;
}

// Валидация записи
function validateSignup(raid, character) {
  const rt = raid.raid_types;
  const weekSignups = (raid.signups || []).filter(s => s.week_start === weekStartDate());
  const signed = weekSignups.length;

  // ГС
  if (parseFloat(character.item_level) < parseFloat(rt.required_ilvl)) {
    return `Нужен ГС ${rt.required_ilvl}, у ${character.name} — ${character.item_level}`;
  }

  // Полнота
  if (signed >= raid.max_players) {
    return 'Рейд заполнен';
  }

  // Тот же игрок уже на этом рейде (через любого персонажа)
  const sameMember = (raid.signups || []).some(s => s.week_start === weekStartDate() && s.member_id === state.member.id);
  if (sameMember) {
    return 'Ты уже записан на этот рейд другим персонажем';
  }

  // Тот же персонаж уже на рейде с таким же name в текущей неделе
  const sameCharOnSameBoss = state.raids.some(r => {
    if (r.raid_types.name !== rt.name) return false;
    return (r.signups || []).some(s => s.week_start === weekStartDate() && s.character_id === character.id);
  });
  if (sameCharOnSameBoss) {
    return `${character.name} уже записан на ${rt.name} на этой неделе`;
  }

  return null;
}

$('add-raid-btn').addEventListener('click', openRaidModal);
$('modal-raid-close')?.addEventListener('click',closeRaidModal);
function closeRaidModal(){ $('modal-raid').classList.remove('active'); $('raid-step-1').classList.add('active'); $('raid-step-2').classList.remove('active'); $('raid-step-3').classList.remove('active'); state.pendingRaidType=null; }

function openRaidModal() {
  $('modal-raid').classList.add('active');
  $('raid-step-1').classList.add('active');
  $('raid-step-2').classList.remove('active');
  $('raid-step-3').classList.remove('active');
  state.pendingRaidType = null;
  renderRaidTypeGrid();
}

// Шаг 1: сетка рейдов
function renderRaidTypeGrid() {
  const grid = $('raid-type-grid');
  grid.innerHTML = '';

  // Уникальные имена рейдов
  const names = [...new Set(state.raidTypes.map(rt => rt.name))];

  for (const name of names) {
    const opt = document.createElement('div');
    opt.className = 'raid-type-option';
    opt.textContent = name;
    opt.addEventListener('click', () => selectRaidType(name));
    grid.appendChild(opt);
  }
}

// Шаг 2: выбор сложности
function selectRaidType(name) {
  state.pendingRaidTypeName = name;

  $('raid-step-1').classList.remove('active');
  $('raid-step-2').classList.add('active');

  const grid = $('raid-mode-grid');
  grid.innerHTML = '';

  const modes = state.raidTypes.filter(rt => rt.name === name);

  for (const rt of modes) {
    const opt = document.createElement('div');
    opt.className = 'raid-mode-option raid-mode-' + rt.mode.toLowerCase();
    opt.textContent = rt.mode;
    opt.addEventListener('click', () => selectRaidMode(rt));
    grid.appendChild(opt);
  }
}

// Шаг 3: выбор даты/времени
function selectRaidMode(rt) {
  state.pendingRaidType = rt;

  $('raid-step-2').classList.remove('active');
  $('raid-step-3').classList.add('active');

  $('raid-mode-title').textContent = `${rt.name} — ${rt.mode}`;
  $('raid-required-ilvl').textContent = rt.required_ilvl;

  $('raid-weekday-input').value = '3';
  $('raid-time-input').value = '20:00';
}

// Создать повторяющийся недельный слот
$('raid-create-btn').addEventListener('click',async()=>{
 const weekday=Number($('raid-weekday-input').value),start_time=$('raid-time-input').value;
 if(!weekday||!start_time){showToast('Выбери день и время','error');return;}
 const r=await createRaid({raid_type_id:state.pendingRaidType.id,weekday,start_time,max_players:state.pendingRaidType.size,created_by:state.member.id});
 if(r.error){showToast('Не удалось создать слот','error');console.error(r.error);return;}
 closeRaidModal();showToast('Слот добавлен','success');await loadRaids();renderSchedule();
});


function weekStartDate(){const n=new Date(new Date().toLocaleString('en-US',{timeZone:'Europe/Moscow'}));const back=(n.getDay()-3+7)%7+(n.getDay()===3&&n.getHours()<6?7:0);n.setDate(n.getDate()-back);n.setHours(6,0,0,0);return new Date(n.getTime()-10800000).toISOString().slice(0,10);}
const BOARD_KEYS=['Арсенос','Серка','Казерос','Армог'];
function setupTabs(){const nav=$('dragons-tabs');if(!nav)return;nav.querySelectorAll('[data-tab]').forEach(btn=>btn.addEventListener('click',()=>{nav.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x===btn));$('schedule-view').classList.toggle('hidden',btn.dataset.tab!=='schedule');$('raids-view').classList.toggle('hidden',btn.dataset.tab!=='raids');if(btn.dataset.tab==='raids')loadRaidBoard();}));}
function normalIlvl(key){const list=state.raidTypes.filter(x=>x.name===key);return Number((list.find(x=>/normal|обыч/i.test(x.mode))||list[0])?.required_ilvl||Infinity);}
async function loadRaidBoard(){const body=$('raid-board-body');if(!body||!state.member)return;if(!state.characters.length)await loadCharacters();body.innerHTML='';const ids=state.characters.map(c=>c.id);let progress=[];if(ids.length){const q=await dragonsSupabase.from('character_raid_progress').select('character_id,raid_key,completed').in('character_id',ids);if(q.error){body.innerHTML='<tr><td colspan="6">Ошибка загрузки отметок. Проверь RLS таблицы прогресса.</td></tr>';return;}progress=q.data||[];}
const done=new Map(progress.map(p=>[p.character_id+'|'+p.raid_key,p.completed]));const signed=new Set();for(const r of state.raids)for(const s of r.signups||[])if(s.member_id===state.member.id&&s.week_start===weekStartDate())signed.add(s.character_id+'|'+r.raid_types?.name);
const chars=[...state.characters].sort((a,b)=>(a.sort_order==null?Infinity:a.sort_order)-(b.sort_order==null?Infinity:b.sort_order));for(const ch of chars){const tr=document.createElement('tr');tr.draggable=true;tr.dataset.id=ch.id;const name=document.createElement('td');name.className='board-character';name.textContent=ch.name;tr.appendChild(name);const coinCell=document.createElement('td');const coin=document.createElement('button');coin.className='coin-toggle'+(ch.gold_coin_active===false?' muted':'');coin.textContent='◉';coin.title='Сбор золота';coin.onclick=async()=>{const v=ch.gold_coin_active===false;const {error}=await dragonsSupabase.from('characters').update({gold_coin_active:v}).eq('id',ch.id);if(error){showToast('Не удалось сохранить','error');return;}ch.gold_coin_active=v;coin.classList.toggle('muted',!v);};coinCell.appendChild(coin);tr.appendChild(coinCell);let all=true;
for(const key of BOARD_KEYS){const td=document.createElement('td');const can=Number(ch.item_level||0)>=normalIlvl(key),doneNow=done.get(ch.id+'|'+key)===true,isSigned=signed.has(ch.id+'|'+key);if(!doneNow)all=false;const btn=document.createElement('button');btn.className='progress-toggle '+(!can?'blocked':doneNow?'done':isSigned?'signed':'empty');btn.textContent=!can?'×':doneNow?'✓':isSigned?'−':'';btn.disabled=!can;btn.title=!can?'Недостаточный ГС':doneNow?'Снять отметку':'Отметить выполнение';btn.onclick=async()=>{const {error}=await dragonsSupabase.from('character_raid_progress').upsert({character_id:ch.id,raid_key:key,completed:!doneNow,updated_at:new Date().toISOString()},{onConflict:'character_id,raid_key'});if(error){showToast('Не удалось сохранить отметку','error');return;}loadRaidBoard();};td.appendChild(btn);tr.appendChild(td);}if(all)tr.classList.add('all-done');
tr.addEventListener('dragstart',e=>{state.draggingId=String(ch.id);e.dataTransfer.setData('text/plain',String(ch.id));e.dataTransfer.effectAllowed='move';tr.classList.add('dragging');});tr.addEventListener('dragend',()=>{state.draggingId=null;tr.classList.remove('dragging');});tr.addEventListener('dragover',e=>{if(state.draggingId&&state.draggingId!==String(ch.id)){e.preventDefault();e.dataTransfer.dropEffect='move';}});tr.addEventListener('drop',async e=>{e.preventDefault();const raw=e.dataTransfer.getData('text/plain')||state.draggingId;if(!raw||raw===String(ch.id))return;const rows=[...body.querySelectorAll('tr[data-id]')];const moving=rows.find(r=>r.dataset.id===raw);if(!moving)return;const a=rows.indexOf(moving),z=rows.findIndex(r=>r.dataset.id===ch.id);if(a<0||z<0)return;if(a<z){moving.remove();rows[z].after(moving);}else{rows[z].before(moving);}const order=[...body.querySelectorAll('tr[data-id]')].map(x=>x.dataset.id);state.draggingId=null;moving.classList.remove('dragging');try{for(let i=0;i<order.length;i++){const {error}=await dragonsSupabase.from('characters').update({sort_order:i+1}).eq('id',order[i]);if(error){console.error('sort_order update:',error);showToast('Не удалось сохранить порядок. Проверь, что в таблице characters есть колонка sort_order и права на UPDATE.','error');return;}}}catch(err){console.error(err);showToast('Ошибка сохранения порядка: '+err.message,'error');return;}state.characters.sort((x,y)=>order.indexOf(String(x.id))-order.indexOf(String(y.id)));loadRaidBoard();});body.appendChild(tr);}}
setupTabs();

// ------------------------------------------------------------
// СТАРТ
// ------------------------------------------------------------
init();