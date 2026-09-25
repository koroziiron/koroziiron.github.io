// ============================================================
// ОСНОВНАЯ ЛОГИКА UI
// ============================================================
import {
  login,
  getCharacters,
  getClasses,
  saveChanges,
  ping,
} from './api.js';

// ------------------------------------------------------------
// ГЛОБАЛЬНОЕ СОСТОЯНИЕ
// ------------------------------------------------------------
const state = {
  member: null,           // { id, nickname }
  characters: [],         // загруженные из БД
  classes: [],            // справочник классов
  editMode: false,
  draft: {
    updated: {},          // { charId: { item_level, combat_power } }
    inserted: [],         // [{ tempId, name, class_id, icon_id, role, item_level, combat_power }]
    deleted: new Set(),   // Set of charId
  },
  pendingClass: null,     // { id, name, role, icon_id } — выбранный класс в модалке
  tempIdCounter: 0,
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

  // Загружаем классы (один раз)
  if (state.classes.length === 0) {
    const r = await getClasses();
    if (r.classes) state.classes = r.classes;
  }

  // Загружаем персонажей
  await loadCharacters();
  renderCharacters();
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

  // Помечен на удаление?
  if (state.draft.deleted.has(ch.id)) {
    card.classList.add('marked-delete');
  }

  // Иконка
  const iconWrap = document.createElement('div');
  iconWrap.className = 'char-icon-wrap';
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
    use.setAttribute('href', '#' + cls.icon_id);   // ← было '#icon-' + cls.icon_id
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
// СТАРТ
// ------------------------------------------------------------
init();