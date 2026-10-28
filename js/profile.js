// ============================================================
// ПРОФИЛЬ И КОМАНДЫ (КП)
// Вкладка «Профиль»: ник, Discord, смена пароля, мои команды,
// вступление / создание, состав команды, панель лидера.
// Логика пока на сайте; позже переедет в API (сигнатуры функций api.js сохранятся).
// ============================================================
import {
  updateNickname, changePassword, verifyPassword, updateDiscordName,
  getTeamDetails, createTeam, joinTeam, removeTeamMember, setInviteCode, disbandTeam,
} from './api.js';

let ctx = null;   // { state, $, showToast, getIconViewBox, getGsClass, saveMember, logout, onMemberUpdated, onTeamsChanged }

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const me = () => ctx.state.member;
const isLeader = team => team.leader_id === me().id;

// ------------------------------------------------------------
// ДИАЛОГИ (можно открывать один поверх другого)
// ------------------------------------------------------------
let dialogZ = 1100;
function openDialog({ title, wide = false, build, actions = [], closable = true }) {
  const overlay = el('div', 'modal-overlay active');
  overlay.style.zIndex = String(++dialogZ);
  const box = el('div', 'modal app-dialog' + (wide ? ' wide' : ''));
  const close = () => overlay.remove();
  if (closable) {
    const x = el('button', 'modal-close', '✕');
    x.title = 'Закрыть';
    x.addEventListener('click', close);
    box.appendChild(x);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  }
  if (title) box.appendChild(el('h3', 'modal-title', title));
  const body = el('div', 'app-dialog-body');
  box.appendChild(body);
  const footer = el('div', 'app-dialog-actions');
  const btns = actions.map(a => {
    const b = el('button', 'dlg-btn ' + (a.kind || 'ghost'), a.label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      b.disabled = true;
      let keep = false;
      try { keep = (await a.onClick?.(api)) === false; } finally { b.disabled = false; }
      if (!keep) close();
    });
    footer.appendChild(b);
    return b;
  });
  if (actions.length) box.appendChild(footer);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  const api = { close, body, box, buttons: btns };
  build?.(body, api);
  return api;
}

function confirmDialog({ title, text, okLabel = 'Да', danger = false }) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const d = openDialog({
      title,
      build: body => body.appendChild(el('p', 'dlg-text', text)),
      actions: [
        { label: 'Отмена', kind: 'ghost', onClick: () => finish(false) },
        { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: () => finish(true) },
      ],
    });
    // закрытие крестиком/фоном = отказ
    const obs = new MutationObserver(() => { if (!document.body.contains(d.box.parentNode)) { finish(false); obs.disconnect(); } });
    obs.observe(document.body, { childList: true });
  });
}

function inputField(label, opts = {}) {
  const wrap = el('div', 'dlg-field');
  if (label) wrap.appendChild(el('label', 'profile-label', label));
  const input = el('input', 'profile-input');
  input.type = opts.type || 'text';
  input.maxLength = opts.maxLength || 64;
  input.placeholder = opts.placeholder || '';
  input.autocomplete = 'off';
  input.spellcheck = false;
  wrap.appendChild(input);
  return { wrap, input };
}

function errText(code, fallback = 'Ошибка сервера, попробуйте позже') {
  const known = {
    invalid: 'Проверьте введённые данные',
    taken: 'Этот ник уже занят',
    name_taken: 'Команда с таким названием уже существует',
    code_taken: 'Такой код приглашения уже используется',
    not_found: 'Команда с таким кодом не найдена',
    already: 'Вы уже состоите в этой команде',
    unavailable: 'Этот пароль использовать нельзя, выберите другой',
    server: fallback,
  };
  if (known[code]) return known[code];
  return typeof code === 'string' && /\s/.test(code) ? code : fallback; // русские сообщения триггеров БД
}

// ------------------------------------------------------------
// ИНИЦИАЛИЗАЦИЯ
// ------------------------------------------------------------
export function initProfile(c) {
  ctx = c;
  const $ = ctx.$;

  // Ник
  $('profile-nickname-save').addEventListener('click', async () => {
    const v = $('profile-nickname').value.trim();
    if (v === me().nickname) return;
    const r = await updateNickname(me().id, v);
    if (r.error) { ctx.showToast(errText(r.error), 'error'); return; }
    ctx.state.member = { ...me(), ...r.member };
    ctx.saveMember();
    ctx.onMemberUpdated();
    ctx.showToast('Ник изменён', 'success');
  });

  // Discord: «@» зафиксирован слева, в поле только сам ник
  const dInput = $('profile-discord');
  dInput.addEventListener('input', () => {
    dInput.value = dInput.value.replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9_.]/g, '');
  });
  $('profile-discord-save').addEventListener('click', async () => {
    const r = await updateDiscordName(me().id, dInput.value);
    if (r.error) { ctx.showToast(errText(r.error, 'Ник Discord: 2–32 символа, a–z, 0–9, _ и .'), 'error'); return; }
    ctx.state.member = { ...me(), ...r.member };
    ctx.saveMember();
    renderDiscordStatus();
    // TODO(API): здесь уйдёт запрос на проверку ника ботом на серверах, где он есть
    ctx.showToast('Discord-ник сохранён', 'success');
  });

  // Смена пароля
  $('profile-pass-save').addEventListener('click', async () => {
    const p1 = $('profile-pass-new').value;
    const p2 = $('profile-pass-confirm').value;
    if (p1.length < 8) { ctx.showToast('Пароль должен быть не короче 8 символов', 'error'); return; }
    if (p1 !== p2) { ctx.showToast('Пароли не совпадают', 'error'); return; }
    const ok = await confirmDialog({
      title: 'Смена пароля',
      text: 'Пароль будет изменён, а вы выйдете из аккаунта на всех устройствах. Войти нужно будет с новым паролем. Продолжить?',
      okLabel: 'Сменить пароль',
    });
    if (!ok) return;
    const r = await changePassword(me().id, p1);
    if (r.error) { ctx.showToast(errText(r.error), 'error'); return; }
    $('profile-pass-new').value = '';
    $('profile-pass-confirm').value = '';
    ctx.logout('Пароль изменён. Войдите с новым паролем.');
  });
}

export function renderProfile() {
  if (!ctx || !me()) return;
  ctx.$('profile-nickname').value = me().nickname || '';
  ctx.$('profile-discord').value = me().discord_name || '';
  renderDiscordStatus();
  renderTeams();
}

function renderDiscordStatus() {
  const m = me();
  const st = ctx.$('profile-discord-status');
  if (!m.discord_name) st.textContent = 'Нужен, чтобы бот мог упоминать вас на рейдах.';
  else if (m.discord_verified_at) st.textContent = '✓ Ник подтверждён ботом';
  else st.textContent = 'Ник сохранён, проверка ботом пока недоступна.';
  st.classList.toggle('ok', !!(m.discord_name && m.discord_verified_at));
}

// ------------------------------------------------------------
// СПИСОК МОИХ КОМАНД
// ------------------------------------------------------------
function renderTeams() {
  const list = ctx.$('teams-list');
  list.replaceChildren();
  for (const team of ctx.state.teams) {
    const row = el('div', 'team-row');
    const main = el('button', 'team-row-main');
    main.type = 'button';
    main.title = 'Состав команды';
    main.appendChild(el('span', 'team-row-name', team.name));
    if (isLeader(team)) main.appendChild(el('span', 'team-badge', 'Лидер'));
    main.addEventListener('click', () => openTeamDialog(team));
    row.appendChild(main);
    if (!isLeader(team)) {
      const leave = el('button', 'team-leave-btn', '✕');
      leave.type = 'button';
      leave.title = 'Покинуть команду';
      leave.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: 'Покинуть команду',
          text: `Вы уверены, что хотите покинуть команду «${team.name}»? Ваши записи на её рейды будут сняты.`,
          okLabel: 'Покинуть', danger: true,
        });
        if (!ok) return;
        const r = await removeTeamMember(team.id, me().id);
        if (r.error) { ctx.showToast(errText(r.error), 'error'); return; }
        ctx.showToast('Вы покинули команду', 'success');
        await ctx.onTeamsChanged();
      });
      row.appendChild(leave);
    }
    list.appendChild(row);
  }
  const add = el('button', 'team-add-tile');
  add.type = 'button';
  add.title = 'Присоединиться или создать команду';
  add.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>';
  add.addEventListener('click', openJoinOrCreate);
  list.appendChild(add);
}

// ------------------------------------------------------------
// ВСТУПИТЬ / СОЗДАТЬ
// ------------------------------------------------------------
function openJoinOrCreate() {
  const d = openDialog({
    title: 'Команда',
    build: (body, api) => {
      const row = el('div', 'choice-row');
      const join = el('button', 'choice-btn', 'Присоединиться');
      const create = el('button', 'choice-btn', 'Создать команду');
      join.type = create.type = 'button';
      join.addEventListener('click', () => { api.close(); openJoinDialog(); });
      create.addEventListener('click', () => { api.close(); openCreateDialog(); });
      row.append(join, create);
      body.appendChild(row);
    },
  });
  return d;
}

function openJoinDialog() {
  const f = inputField('Код приглашения', { maxLength: 24, placeholder: 'Например, A1B2C3D4E5' });
  f.input.classList.add('code-input');
  openDialog({
    title: 'Присоединиться к команде',
    build: body => { body.appendChild(f.wrap); setTimeout(() => f.input.focus(), 30); },
    actions: [
      { label: 'Отмена', kind: 'ghost' },
      { label: 'Присоединиться', kind: 'primary', onClick: async () => {
        const r = await joinTeam(me().id, f.input.value);
        if (r.error) { ctx.showToast(errText(r.error), 'error'); return false; }
        ctx.showToast(`Вы вступили в команду «${r.team.name}»`, 'success');
        await ctx.onTeamsChanged();
      } },
    ],
  });
}

function openCreateDialog() {
  const f = inputField('Название команды', { maxLength: 40, placeholder: 'От 2 до 40 символов' });
  openDialog({
    title: 'Создать команду',
    build: body => {
      body.appendChild(f.wrap);
      body.appendChild(el('p', 'field-hint', 'Вы станете лидером команды. Лидер не может её покинуть, но может распустить.'));
      setTimeout(() => f.input.focus(), 30);
    },
    actions: [
      { label: 'Отмена', kind: 'ghost' },
      { label: 'Создать', kind: 'primary', onClick: async () => {
        const r = await createTeam(me().id, f.input.value);
        if (r.error) { ctx.showToast(errText(r.error), 'error'); return false; }
        ctx.showToast(`Команда «${r.team.name}» создана`, 'success');
        await ctx.onTeamsChanged();
      } },
    ],
  });
}

// ------------------------------------------------------------
// СОСТАВ КОМАНДЫ
// ------------------------------------------------------------
function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

function charRow(ch) {
  const row = el('div', 'tm-char');
  const iconId = ch.classes?.icon_id || 'berserker';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'tm-char-icon');
  svg.setAttribute('viewBox', ctx.getIconViewBox(iconId));
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + iconId);
  svg.appendChild(use);
  row.appendChild(svg);
  row.appendChild(el('span', 'tm-char-name', ch.name));
  const gs = el('span', 'tm-char-gs ' + ctx.getGsClass(ch.item_level), ch.item_level ? String(ch.item_level) : '');
  const bs = el('span', 'tm-char-bs ' + (ch.classes?.role === 'SUPPORT' ? 'bs-support' : 'bs-dps'), ch.combat_power ? String(ch.combat_power) : '');
  row.append(gs, bs);
  return row;
}

function openTeamDialog(team) {
  const leader = isLeader(team);
  openDialog({
    title: team.name,
    wide: leader,
    build: (body, api) => {
      const layout = el('div', 'team-dialog' + (leader ? ' with-leader' : ''));
      const left = el('div', 'team-dialog-members');
      left.appendChild(el('div', 'profile-label', 'Участники'));
      const listEl = el('div', 'tm-list', 'Загрузка…');
      left.appendChild(listEl);
      layout.appendChild(left);

      const expanded = new Set();
      const load = async () => {
        const r = await getTeamDetails(team.id);
        if (r.error) { listEl.textContent = 'Не удалось загрузить состав'; return; }
        const members = r.members.sort((a, b) =>
          (b.id === team.leader_id) - (a.id === team.leader_id) || a.nickname.localeCompare(b.nickname, 'ru'));
        listEl.replaceChildren();
        for (const m of members) {
          const item = el('div', 'tm-item');
          const head = el('div', 'tm-head');
          const toggle = el('button', 'tm-toggle');
          toggle.type = 'button';
          toggle.appendChild(el('span', 'tm-arrow', expanded.has(m.id) ? '▾' : '▸'));
          toggle.appendChild(el('span', 'tm-nick', m.nickname));
          if (m.id === team.leader_id) toggle.appendChild(el('span', 'team-badge', 'Лидер'));
          toggle.appendChild(el('span', 'tm-count', String(m.characters.length)));
          const chars = el('div', 'tm-chars' + (expanded.has(m.id) ? '' : ' hidden'));
          if (m.characters.length) m.characters.forEach(c => chars.appendChild(charRow(c)));
          else chars.appendChild(el('div', 'tm-empty', 'Нет персонажей'));
          toggle.addEventListener('click', () => {
            if (expanded.has(m.id)) expanded.delete(m.id); else expanded.add(m.id);
            chars.classList.toggle('hidden', !expanded.has(m.id));
            toggle.firstChild.textContent = expanded.has(m.id) ? '▾' : '▸';
          });
          head.appendChild(toggle);
          if (leader && m.id !== me().id) {
            const kick = el('button', 'team-leave-btn small', '✕');
            kick.type = 'button';
            kick.title = 'Изгнать из команды';
            kick.addEventListener('click', async () => {
              const ok = await confirmDialog({
                title: 'Изгнать участника',
                text: `Вы уверены, что хотите изгнать «${m.nickname}» из команды? Его записи на рейды команды будут сняты.`,
                okLabel: 'Изгнать', danger: true,
              });
              if (!ok) return;
              const rr = await removeTeamMember(team.id, m.id);
              if (rr.error) { ctx.showToast(errText(rr.error), 'error'); return; }
              ctx.showToast('Участник изгнан', 'success');
              await load();
              ctx.onTeamsChanged({ keepProfile: true });
            });
            head.appendChild(kick);
          }
          item.append(head, chars);
          listEl.appendChild(item);
        }
      };
      load();

      if (leader) layout.appendChild(buildLeaderPanel(team, api));
      body.appendChild(layout);
    },
  });
}

function buildLeaderPanel(team, dialogApi) {
  const panel = el('div', 'team-dialog-leader');
  panel.appendChild(el('div', 'profile-label', 'Код приглашения'));
  const row = el('div', 'field-row');
  const code = el('input', 'profile-input code-input');
  code.maxLength = 24;
  code.value = team.invite_code;
  code.spellcheck = false;
  code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ''); sync(); });
  const dice = el('button', 'check-btn', '⟳');
  dice.type = 'button';
  dice.title = 'Сгенерировать случайный код';
  dice.addEventListener('click', () => { code.value = randomCode(); sync(); });
  const ok = el('button', 'check-btn', '✓');
  ok.type = 'button';
  ok.title = 'Применить новый код';
  const sync = () => { ok.disabled = !(code.value !== team.invite_code && /^[A-Z0-9_-]{6,24}$/.test(code.value)); };
  sync();
  ok.addEventListener('click', async () => {
    const yes = await confirmDialog({
      title: 'Изменить код приглашения',
      text: 'Старый код перестанет работать. Участники, которые уже в команде, останутся. Изменить код?',
      okLabel: 'Изменить',
    });
    if (!yes) return;
    const r = await setInviteCode(team.id, code.value);
    if (r.error) { ctx.showToast(errText(r.error), 'error'); return; }
    team.invite_code = r.code;
    const t = ctx.state.teams.find(x => x.id === team.id);
    if (t) t.invite_code = r.code;
    sync();
    ctx.showToast('Код приглашения изменён', 'success');
  });
  row.append(code, dice, ok);
  panel.appendChild(row);
  panel.appendChild(el('p', 'field-hint', 'Передайте код тем, кого хотите пригласить.'));

  const disband = el('button', 'dlg-btn danger disband-btn', 'Распустить команду');
  disband.type = 'button';
  disband.addEventListener('click', () => openDisbandDialog(team, dialogApi));
  panel.appendChild(disband);
  return panel;
}

function openDisbandDialog(team, teamDialogApi) {
  const name = inputField(`Введите название команды: ${team.name}`, { maxLength: 40 });
  const pass = inputField('Ваш пароль', { type: 'password' });
  openDialog({
    title: 'Распустить команду',
    build: body => {
      body.appendChild(el('p', 'dlg-text',
        'Команда, все её рейды и записи на них будут удалены без возможности восстановления. Участники останутся без команды.'));
      body.append(name.wrap, pass.wrap);
    },
    actions: [
      { label: 'Отмена', kind: 'ghost' },
      { label: 'Распустить', kind: 'danger', onClick: async () => {
        if (name.input.value.trim() !== team.name) { ctx.showToast('Название команды введено неверно', 'error'); return false; }
        const v = await verifyPassword(me().id, pass.input.value);
        if (v.error) { ctx.showToast(errText('server'), 'error'); return false; }
        if (!v.ok) { ctx.showToast('Неверный пароль', 'error'); return false; }
        const r = await disbandTeam(team.id);
        if (r.error) { ctx.showToast(errText(r.error), 'error'); return false; }
        teamDialogApi.close();
        ctx.showToast(`Команда «${team.name}» распущена`, 'success');
        await ctx.onTeamsChanged();
      } },
    ],
  });
}
