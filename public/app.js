const $ = (s) => document.querySelector(s);

const state = {
  token: localStorage.getItem('nook_token'),
  me: null,
  servers: [],
  serverId: null,
  server: null,
  channels: [],
  members: [],
  channelId: null,
  unread: new Map(), // channelId -> serverId
  last: null, // last rendered message, for grouping
  msgs: new Map(), // id -> message currently on screen
  view: 'home',
  friends: { friends: [], incoming: [], outgoing: [] },
  dms: [],
  tab: 'online',
  voice: {}, // voice channelId -> users currently in it
  roles: [],
  perms: 0,
  avV: {}, // username -> picture version, bumped when it changes
  noAv: new Set(), // usernames known to have no picture
  dmWith: null,
};
let socket = null;
let signupMode = true;

// ---------- helpers ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) logout();
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

const PALETTE = ['#f2c14e', '#6fd3c3', '#ff8a7a', '#9db4ff', '#c79bff', '#8fd77a', '#ffb36b', '#6cc3f0'];
const colorFor = (str) => PALETTE[[...str].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'style') n.style.cssText = v;
    else n.setAttribute(k, v);
  });
  kids.forEach((k) => n.append(k));
  return n;
}

function avatar(name, color, small) {
  const a = el('span', { class: 'avatar' + (small ? ' small' : ''), style: `background:${color}` }, name[0].toUpperCase());
  if (!state.noAv.has(name)) {
    const img = el('img', { src: `/api/avatars/${encodeURIComponent(name)}?v=${state.avV[name] || 0}`, alt: '' });
    img.onerror = () => { state.noAv.add(name); img.remove(); };
    a.append(img);
  }
  return a;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString() + ' ' + t;
}

function ask(title, label) {
  return new Promise((resolve) => {
    const dlg = $('#askDlg');
    $('#askTitle').textContent = title;
    $('#askLabel').textContent = label;
    $('#askInput').value = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? $('#askInput').value.trim() : null), { once: true });
    dlg.showModal();
    $('#askInput').focus();
  });
}

// ---------- auth ----------
function renderAuthMode() {
  $('#authSubmit').textContent = signupMode ? 'Create account' : 'Log in';
  $('#authSwap').textContent = signupMode ? 'I already have an account' : 'Create a new account';
  $('#authLead').textContent = signupMode ? 'Pick a username and password to get started.' : 'Welcome back.';
  $('#authPass').autocomplete = signupMode ? 'new-password' : 'current-password';
  $('#authError').textContent = '';
}

$('#authSwap').addEventListener('click', () => { signupMode = !signupMode; renderAuthMode(); });

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { token } = await api(signupMode ? '/signup' : '/login', {
      method: 'POST',
      body: { username: $('#authUser').value, password: $('#authPass').value },
    });
    state.token = token;
    localStorage.setItem('nook_token', token);
    $('#authPass').value = '';
    start();
  } catch (err) {
    $('#authError').textContent = err.message;
  }
});

function logout() {
  localStorage.removeItem('nook_token');
  state.token = null;
  if (socket) socket.disconnect();
  location.reload();
}
$('#logout').addEventListener('click', logout);

// ---------- boot ----------
async function start() {
  try {
    const data = await api('/me');
    state.me = data.user;
    state.servers = data.servers;
  } catch {
    $('#auth').hidden = false;
    $('#app').hidden = true;
    renderAuthMode();
    return;
  }
  $('#auth').hidden = true;
  $('#app').hidden = false;
  paintMe();
  $('#meDot').dataset.profile = state.me.id;
  $('#meName').dataset.profile = state.me.id;
  connectSocket();
  renderRail();
  showHome();
}

// ---------- servers ----------
function renderRail() {
  const rail = $('#rail');
  rail.replaceChildren();
  const homeUnread = state.dms.some((d) => state.unread.has(d.channelId));
  const home = el('button', { class: 'srv home' + (state.view === 'home' ? ' active' : '') + (homeUnread ? ' unread' : ''), title: 'Home', 'aria-label': 'Home', onclick: showHome });
  home.innerHTML = LOGO_SVG;
  rail.append(home, el('div', { class: 'sep' }));
  state.servers.forEach((s) => {
    const hasUnread = [...state.unread.values()].includes(s.id);
    rail.append(
      el('button', {
        class: 'srv' + (state.view === 'server' && s.id === state.serverId ? ' active' : '') + (hasUnread ? ' unread' : ''),
        style: `background:${colorFor(s.name)}`,
        title: s.name,
        'aria-label': s.name,
        onclick: () => selectServer(s.id),
      }, s.name[0].toUpperCase())
    );
  });
  rail.append(el('button', { class: 'srv add', title: 'Add a server', 'aria-label': 'Add a server', onclick: () => $('#choiceDlg').showModal() }, '+'));
  rail.append(el('button', { class: 'srv add', title: 'How Nook works', 'aria-label': 'How Nook works', onclick: () => $('#helpDlg').showModal() }, '?'));
}

function showNoServer() {
  state.serverId = state.server = state.channelId = null;
  $('#serverName').textContent = 'Nook';
  $('#inviteBtn').hidden = true;
  $('#addChannel').hidden = true;
  $('#channels').replaceChildren();
  $('#members').replaceChildren();
  $('#channelName').textContent = '';
  $('#messages').replaceChildren(
    el('div', { class: 'empty' }, el('h3', {}, 'No servers yet'), 'Create one with the + button, or join a friend using their invite code.')
  );
}

async function selectServer(id) {
  const data = await api('/servers/' + id);
  state.serverId = id;
  state.server = data.server;
  setView('server');
  state.dmWith = null;
  $('#sideLabel').textContent = 'Channels';
  $('#friends').hidden = true;
  $('#chat').hidden = false;
  state.channels = data.channels;
  state.members = data.members;
  $('#serverName').textContent = data.server.name;
  $('#inviteBtn').hidden = false;
  state.roles = data.roles;
  state.perms = data.perms;
  $('#addChannel').hidden = !(state.perms & 1);
  $('#settingsBtn').hidden = !(state.perms & 6);
  renderRail();
  renderMembers();
  state.channels.filter((c) => c.voice).forEach((c) => { state.voice[c.id] = (data.voice || {})[c.id] || []; });
  const texts = state.channels.filter((c) => !c.voice);
  const prefer = texts.find((c) => state.unread.has(c.id)) || texts[0];
  renderChannels();
  if (prefer) selectChannel(prefer.id);
}

function renderChannels() {
  const box = $('#channels');
  box.replaceChildren();
  const owner = (state.perms & 1) !== 0;
  state.channels.filter((c) => !c.voice).forEach((c) => {
    box.append(el('button', {
      class: 'ch' + (c.id === state.channelId ? ' active' : '') + (state.unread.has(c.id) ? ' unread' : ''),
      onclick: () => selectChannel(c.id),
    }, '# ' + c.name));
  });
  box.append(el('div', { class: 'side-label vrow' }, 'Voice', owner ? el('button', { class: 'icon', title: 'New voice channel', onclick: addVoiceChannel }, '+') : ''));
  state.channels.filter((c) => c.voice).forEach((c) => {
    box.append(el('button', { class: 'ch vc' + (voice.channelId === c.id ? ' active' : ''), onclick: () => { if (voice.channelId !== c.id) joinVoice(c); } }, '🔊 ' + c.name));
    (state.voice[c.id] || []).forEach((u) => box.append(el('div', { class: 'vuser', 'data-profile': u.id }, avatar(u.username, u.color, true), u.username)));
  });
}

function renderMembers() {
  const box = $('#members');
  box.replaceChildren();
  const on = state.members.filter((m) => m.online);
  const off = state.members.filter((m) => !m.online);
  box.append(el('div', { class: 'count' }, el('b', {}, String(state.members.length)), ` members, ${on.length} online`));
  const group = (title, list, cls) => {
    if (!list.length) return;
    box.append(el('h4', {}, `${title} (${list.length})`));
    list.forEach((m) => box.append(el('div', { class: 'mem ' + cls, 'data-profile': m.id }, avatar(m.username, m.color), el('span', { class: 'mname' }, el('b', { style: roleStyle(m) }, m.username), m.status ? el('small', {}, m.status) : ''))));
  };
  group('Online', on, '');
  group('Offline', off, 'off');
}

// ---------- channels + messages ----------
async function selectChannel(id) {
  state.channelId = id;
  state.unread.delete(id);
  state.last = null;
  state.msgs = new Map();
  const ch = state.channels.find((c) => c.id === id);
  const label = state.dmWith ? '@' + state.dmWith.username : '#' + ch.name;
  $('#channelName').textContent = label;
  $('#input').placeholder = `Message ${label}`;
  if (state.view === 'home') renderHomeSide(); else renderChannels();
  renderRail();
  const box = $('#messages');
  box.replaceChildren();
  const msgs = await api(`/channels/${id}/messages`);
  if (state.channelId !== id) return; // user switched while loading
  if (!msgs.length) {
    box.append(el('div', { class: 'empty', id: 'emptyNote' }, el('h3', {}, state.dmWith ? `This is the start of your chat with ${state.dmWith.username}` : `Welcome to ${label}`), 'Nothing here yet. Say something first.'));
  }
  msgs.forEach(appendMessage);
  box.scrollTop = box.scrollHeight;
  $('#input').focus();
}

const REACT = ['👍', '❤️', '😂', '🎉', '😮', '👀'];

function react(id, emoji) {
  api(`/messages/${id}/react`, { method: 'POST', body: { emoji } }).catch((e) => alert(e.message));
}

function renderReactions(node, m) {
  const row = node.querySelector('.reacts');
  row.replaceChildren();
  Object.entries(m.reactions || {}).forEach(([emoji, ids]) => {
    row.append(el('button', {
      class: 'chip' + (ids.includes(state.me.id) ? ' mine' : ''),
      onclick: () => react(m.id, emoji),
    }, `${emoji} ${ids.length}`));
  });
}

function startEdit(node, m) {
  const text = node.querySelector('.text');
  const box = el('textarea', { class: 'edit', rows: '2' });
  box.value = m.content;
  text.replaceWith(box);
  box.focus();
  let finished = false;
  const done = (save) => {
    if (finished) return;
    finished = true;
    const v = box.value.trim();
    box.replaceWith(text);
    if (save && v && v !== m.content) {
      api('/messages/' + m.id, { method: 'PATCH', body: { content: v } }).catch((e) => alert(e.message));
    }
  };
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(true); }
    if (e.key === 'Escape') done(false);
  });
  box.addEventListener('blur', () => done(false));
}

function appendMessage(m) {
  const box = $('#messages');
  const note = $('#emptyNote');
  if (note) note.remove();
  state.msgs.set(m.id, m);
  const prev = state.last;
  const cont = prev && prev.author.id === m.author.id && m.created - prev.created < 5 * 60 * 1000;
  state.last = m;

  const tools = el('div', { class: 'tools' });
  REACT.forEach((emoji) => tools.append(el('button', { title: 'React ' + emoji, onclick: () => react(m.id, emoji) }, emoji)));
  if (m.author.id === state.me.id) {
    tools.append(el('button', { class: 'txt', onclick: () => startEdit(node, m) }, 'Edit'));
    tools.append(el('button', { class: 'txt', onclick: () => api('/messages/' + m.id, { method: 'DELETE' }).catch((e) => alert(e.message)) }, 'Delete'));
  }
  const text = el('div', { class: 'text' }, m.content);
  if (m.edited) text.dataset.edited = '1';
  const node = el('div', { class: 'msg' + (cont ? ' cont' : ''), 'data-id': m.id, 'data-uid': m.author.id },
    el('span', { 'data-profile': m.author.id }, avatar(m.author.username, m.author.color)),
    el('div', { class: 'body' },
      el('div', { class: 'meta' }, el('b', { style: `color:${m.author.color}`, 'data-profile': m.author.id }, m.author.username), el('time', {}, fmtTime(m.created))),
      text,
      el('div', { class: 'reacts' })
    ),
    tools
  );
  renderReactions(node, m);
  box.append(node);
}

function nearBottom() {
  const b = $('#messages');
  return b.scrollHeight - b.scrollTop - b.clientHeight < 120;
}

// ---------- composer ----------
const input = $('#input');
let lastTyping = 0;

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}

input.addEventListener('input', () => {
  autosize();
  const now = Date.now();
  if (state.channelId && now - lastTyping > 2000 && input.value.trim()) {
    lastTyping = now;
    socket.emit('typing', { channelId: state.channelId });
  }
});

input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  const content = input.value.trim();
  if (!content || !state.channelId) return;
  socket.emit('message:send', { channelId: state.channelId, content }, (res) => {
    if (res && res.error) {
      $('#typing').textContent = res.error;
      setTimeout(() => ($('#typing').textContent = ''), 2500);
    }
  });
  input.value = '';
  autosize();
});

// ---------- realtime ----------
const typers = new Map(); // username -> timeout id

function renderTyping() {
  const names = [...typers.keys()];
  $('#typing').textContent = !names.length ? '' : names.length === 1 ? `${names[0]} is typing...` : `${names.slice(0, 3).join(', ')} are typing...`;
}

function connectSocket() {
  socket = io({ auth: { token: state.token } });

  socket.on('connect_error', (err) => { if (err.message === 'auth') logout(); });

  socket.on('message:new', (m) => {
    if (m.channelId === state.channelId) {
      const stick = nearBottom() || m.author.id === state.me.id;
      appendMessage(m);
      if (stick) $('#messages').scrollTop = $('#messages').scrollHeight;
      clearTimeout(typers.get(m.author.username));
      typers.delete(m.author.username);
      renderTyping();
    } else if (m.author.id !== state.me.id) {
      state.unread.set(m.channelId, m.serverId);
      renderRail();
      if (state.view === 'home') renderHomeSide();
      else if (m.serverId === state.serverId) renderChannels();
    }
  });

  socket.on('message:deleted', ({ id }) => {
    const n = document.querySelector(`.msg[data-id="${id}"]`);
    if (n) n.remove();
  });

  socket.on('message:updated', ({ id, content }) => {
    const m = state.msgs.get(id);
    const t = document.querySelector(`.msg[data-id="${id}"] .text`);
    if (!m) return;
    m.content = content;
    m.edited = true;
    if (t) { t.textContent = content; t.dataset.edited = '1'; }
  });

  socket.on('message:reactions', ({ id, reactions }) => {
    const m = state.msgs.get(id);
    const n = document.querySelector(`.msg[data-id="${id}"]`);
    if (!m || !n) return;
    m.reactions = reactions;
    renderReactions(n, m);
  });

  socket.on('voice:state', ({ channelId, users }) => {
    state.voice[channelId] = users;
    if (state.view === 'server') renderChannels();
  });
  socket.on('voice:peers', async (ids) => {
    for (const id of ids) {
      const { pc } = makePeer(id);
      await pc.setLocalDescription(await pc.createOffer());
      socket.emit('voice:signal', { to: id, data: { sdp: pc.localDescription } });
    }
  });
  socket.on('voice:signal', async ({ from, data }) => {
    if (!voice.channelId) return;
    const { pc } = voice.peers.get(from) || makePeer(from);
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          socket.emit('voice:signal', { to: from, data: { sdp: pc.localDescription } });
        }
      } else if (data.ice) {
        await pc.addIceCandidate(data.ice);
      }
    } catch (e) { console.warn('voice signal failed', e); }
  });
  socket.on('voice:left', ({ id }) => closePeer(id));
  socket.on('voice:full', () => { leaveVoice(); alert('That voice channel is full (8 people max).'); });

  socket.on('profile:update', (u) => {
    state.avV[u.username] = Date.now();
    state.noAv.delete(u.username);
    const touch = (x) => { if (x && x.id === u.id) { x.color = u.color; x.status = u.status; } };
    state.members.forEach(touch);
    state.friends.friends.forEach(touch);
    state.friends.incoming.forEach(touch);
    state.dms.forEach((d) => touch(d.user));
    if (state.me.id === u.id) { touch(state.me); paintMe(); }
    document.querySelectorAll(`.msg[data-uid="${u.id}"]`).forEach((n) => {
      n.querySelector('.avatar').replaceWith(avatar(u.username, u.color));
      n.querySelector('.meta b').style.color = u.color;
    });
    if ($('#editDlg').open) renderEditPreview();
    renderMembers();
    if (state.view === 'home') { renderHomeSide(); if (!$('#friends').hidden) renderFriends(); }
  });

  socket.on('server:update', ({ serverId, name }) => {
    const s = state.servers.find((x) => x.id === serverId);
    if (s && name && s.name !== name) { s.name = name; renderRail(); }
    if (serverId === state.serverId) refreshServer().catch(() => {});
  });
  socket.on('server:deleted', ({ serverId }) => {
    state.servers = state.servers.filter((s) => s.id !== serverId);
    if (state.serverId === serverId) { $('#settingsDlg').close(); showHome(); } else renderRail();
  });

  socket.on('typing', ({ channelId, username }) => {
    if (channelId !== state.channelId) return;
    clearTimeout(typers.get(username));
    typers.set(username, setTimeout(() => { typers.delete(username); renderTyping(); }, 3000));
    renderTyping();
  });

  socket.on('presence', ({ userId, online }) => {
    const m = state.members.find((x) => x.id === userId);
    if (m) { m.online = online; renderMembers(); }
    const touch = (u) => { if (u.id === userId) u.online = online; };
    state.friends.friends.forEach(touch);
    state.dms.forEach((d) => touch(d.user));
    if (state.view === 'home') { renderHomeSide(); if (!$('#friends').hidden) renderFriends(); }
  });

  socket.on('friends:update', () => refreshSocial().catch(() => {}));

  socket.on('channel:new', (c) => {
    if (c.server_id !== state.serverId) return;
    if (!state.channels.some((x) => x.id === c.id)) state.channels.push(c);
    renderChannels();
  });

  socket.on('member:new', async ({ serverId }) => {
    if (serverId !== state.serverId) return;
    const data = await api('/servers/' + serverId);
    state.members = data.members;
    renderMembers();
  });
}

// ---------- home: friends + direct messages ----------
const LOGO_SVG = '<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="14" style="fill:var(--accent)"/><path d="M14 36V23a10 10 0 0 1 20 0v13z" style="fill:var(--accent-ink)"/><circle cx="24" cy="29" r="3.2" style="fill:var(--accent)"/></svg>';
const dot = (on) => el('i', { class: 'dot' + (on ? ' on' : '') });

function setView(v) {
  state.view = v;
  $('#app').classList.toggle('home', v === 'home');
}

async function refreshSocial() {
  const [f, d] = await Promise.all([api('/friends'), api('/dms')]);
  state.friends = f;
  state.dms = d;
  if (state.view === 'home') {
    renderHomeSide();
    if (!$('#friends').hidden) renderFriends();
  }
  renderRail();
}

function renderHomeSide() {
  const box = $('#channels');
  box.replaceChildren();
  const n = state.friends.incoming.length;
  box.append(el('button', { class: 'ch' + (!state.dmWith ? ' active' : ''), onclick: showFriendsPanel }, 'Friends' + (n ? ` (${n})` : '')));
  box.append(el('div', { class: 'side-label' }, 'Direct messages'));
  if (!state.dms.length) box.append(el('p', { class: 'hint' }, 'Open a friend from the Friends tab to start a chat.'));
  state.dms.forEach((d) => {
    const active = state.dmWith && state.dmWith.id === d.user.id;
    box.append(el('button', { class: 'ch dm' + (active ? ' active' : '') + (state.unread.has(d.channelId) ? ' unread' : ''), onclick: () => openDm(d) },
      avatar(d.user.username, d.user.color, true), el('span', { class: 'dmname' }, d.user.username), dot(d.user.online)));
  });
}

function showFriendsPanel() {
  state.dmWith = null;
  state.channelId = null;
  $('#chat').hidden = true;
  $('#friends').hidden = false;
  renderFriends();
  renderHomeSide();
}

function renderFriends() {
  const f = state.friends;
  const nav = $('#friendTabs');
  nav.replaceChildren();
  [['online', 'Online'], ['all', 'All'], ['pending', 'Pending' + (f.incoming.length ? ` (${f.incoming.length})` : '')]].forEach(([k, label]) =>
    nav.append(el('button', { class: 'tab' + (state.tab === k ? ' active' : ''), onclick: () => { state.tab = k; renderFriends(); } }, label)));

  const btn = (label, fn, cls = '') => el('button', { class: cls, onclick: fn }, label);
  const row = (u, sub, ...actions) => el('div', { class: 'frow' }, avatar(u.username, u.color), el('div', { class: 'finfo', 'data-profile': u.id }, el('b', {}, u.username), el('small', {}, sub)), ...actions);
  const rows = [];
  if (state.tab === 'pending') {
    f.incoming.forEach((u) => rows.push(row(u, 'Wants to be your friend',
      btn('Accept', () => friendAction(`/friends/${u.id}/accept`, 'POST'), 'primary'), btn('Decline', () => friendAction('/friends/' + u.id, 'DELETE')))));
    f.outgoing.forEach((u) => rows.push(row(u, 'Request sent', btn('Cancel', () => friendAction('/friends/' + u.id, 'DELETE')))));
  } else {
    f.friends.filter((u) => state.tab === 'all' || u.online).forEach((u) => rows.push(row(u, u.online ? 'Online' : 'Offline',
      btn('Message', () => openDmWith(u.id), 'primary'), btn('Remove', () => friendAction('/friends/' + u.id, 'DELETE')))));
  }
  const empty = { online: 'Nobody is online right now. Check the All tab.', all: 'No friends yet. Type a username above to send a request.', pending: 'No pending requests.' };
  $('#friendList').replaceChildren(...(rows.length ? rows : [el('div', { class: 'empty' }, empty[state.tab])]));
}

async function friendAction(path, method) {
  try { await api(path, { method }); await refreshSocial(); } catch (e) { alert(e.message); }
}

async function showHome() {
  setView('home');
  state.serverId = state.server = null;
  $('#serverName').textContent = 'Home';
  $('#sideLabel').textContent = '';
  $('#inviteBtn').hidden = true;
  $('#addChannel').hidden = true;
  $('#settingsBtn').hidden = true;
  if (!state.dmWith) { $('#chat').hidden = true; $('#friends').hidden = false; }
  try { await refreshSocial(); } catch {}
  if (!state.dmWith) showFriendsPanel();
  renderRail();
}

function openDm(d) {
  state.dmWith = d.user;
  state.serverId = null;
  state.channels = [{ id: d.channelId, name: 'dm' }];
  $('#friends').hidden = true;
  $('#chat').hidden = false;
  renderHomeSide();
  selectChannel(d.channelId);
}

async function openDmWith(userId) {
  try {
    const r = await api('/dms', { method: 'POST', body: { userId } });
    if (!state.dms.some((x) => x.channelId === r.channelId)) {
      state.dms.unshift({ serverId: r.serverId, channelId: r.channelId, user: state.friends.friends.find((u) => u.id === userId) });
    }
    openDm(state.dms.find((x) => x.channelId === r.channelId));
  } catch (e) { alert(e.message); }
}

$('#addFriend').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#addFriendInput');
  const msg = $('#friendMsg');
  try {
    const r = await api('/friends', { method: 'POST', body: { username: input.value.trim() } });
    msg.className = 'friendmsg ok';
    msg.textContent = r.accepted ? `You and ${r.username} are now friends.` : `Request sent to ${r.username}.`;
    input.value = '';
    refreshSocial();
  } catch (err) {
    msg.className = 'friendmsg bad';
    msg.textContent = err.message;
  }
});

// ---------- voice chat (WebRTC mesh, signalled through Socket.IO) ----------
const voice = { channelId: null, name: '', stream: null, peers: new Map(), muted: false };
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function makePeer(id) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  voice.stream.getTracks().forEach((t) => pc.addTrack(t, voice.stream));
  const audio = document.createElement('audio');
  audio.autoplay = true;
  document.body.append(audio);
  pc.ontrack = (e) => { audio.srcObject = e.streams[0]; };
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit('voice:signal', { to: id, data: { ice: e.candidate } }); };
  const peer = { pc, audio };
  voice.peers.set(id, peer);
  return peer;
}

function closePeer(id) {
  const p = voice.peers.get(id);
  if (!p) return;
  p.pc.close();
  p.audio.srcObject = null;
  p.audio.remove();
  voice.peers.delete(id);
}

function renderVoiceBar() {
  const on = !!voice.channelId;
  $('#voiceBar').hidden = !on;
  if (!on) return;
  $('#voiceName').textContent = '🔊 ' + voice.name;
  $('#muteBtn').textContent = voice.muted ? 'Unmute' : 'Mute';
}

async function joinVoice(ch) {
  if (!navigator.mediaDevices || !window.RTCPeerConnection) return alert('Voice needs a modern browser on https:// or localhost.');
  if (voice.channelId) leaveVoice();
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    return alert('Nook could not reach your microphone. Allow microphone access and try again.');
  }
  voice.channelId = ch.id;
  voice.name = ch.name;
  voice.muted = false;
  socket.emit('voice:join', { channelId: ch.id });
  renderVoiceBar();
  if (state.view === 'server') renderChannels();
}

function leaveVoice() {
  if (!voice.channelId) return;
  socket.emit('voice:leave');
  [...voice.peers.keys()].forEach(closePeer);
  voice.stream.getTracks().forEach((t) => t.stop());
  voice.channelId = null;
  voice.stream = null;
  renderVoiceBar();
  if (state.view === 'server') renderChannels();
}

async function addVoiceChannel() {
  const name = await ask('New voice channel', 'Channel name');
  if (!name) return;
  try {
    const c = await api(`/servers/${state.serverId}/channels`, { method: 'POST', body: { name, voice: true } });
    if (!state.channels.some((x) => x.id === c.id)) state.channels.push(c);
    renderChannels();
  } catch (e) { alert(e.message); }
}

$('#muteBtn').addEventListener('click', () => {
  voice.muted = !voice.muted;
  voice.stream.getAudioTracks().forEach((t) => (t.enabled = !voice.muted));
  renderVoiceBar();
});
$('#leaveBtn').addEventListener('click', leaveVoice);

// ---------- profiles ----------
function paintMe() {
  $('#meName').textContent = state.me.username;
  const av = avatar(state.me.username, state.me.color, true);
  av.id = 'meDot';
  av.dataset.profile = state.me.id;
  $('#meDot').replaceWith(av);
}

async function showProfile(id) {
  try {
    const u = await api('/users/' + id);
    $('#profileBody').replaceChildren(
      el('div', { class: 'pbanner', style: `background:${u.color}` }),
      el('div', { class: 'pmain' },
        avatar(u.username, u.color),
        el('h3', {}, u.username),
        el('p', { class: 'pstatus' }, u.online ? 'Online' : 'Offline'),
        u.status ? el('p', { class: 'pquote' }, u.status) : '',
        u.bio ? el('div', { class: 'pbio' }, el('b', {}, 'About'), el('p', {}, u.bio)) : '',
        el('small', {}, 'Member since ' + new Date(u.created).toLocaleDateString())
      )
    );
    $('#profileEdit').hidden = id !== state.me.id;
    $('#profileDlg').showModal();
  } catch (e) { alert(e.message); }
}

let editColor = '#6670f5';
function renderEditPreview() {
  const av = avatar(state.me.username, editColor);
  av.id = 'editAvatar';
  $('#editAvatar').replaceWith(av);
  $('#editName').textContent = state.me.username;
  $('#editName').style.color = editColor;
  document.querySelectorAll('#swatches .swatch').forEach((b) => b.classList.toggle('on', b.dataset.c === editColor));
  $('#editColor').value = editColor;
}

async function openEdit() {
  try {
    const u = await api('/users/' + state.me.id);
    editColor = u.color;
    $('#editStatus').value = u.status || '';
    $('#editBio').value = u.bio || '';
    $('#swatches').replaceChildren(
      ...PALETTE.map((c) => el('button', { type: 'button', class: 'swatch', 'data-c': c, style: `background:${c}`, 'aria-label': 'Colour ' + c, onclick: () => { editColor = c; renderEditPreview(); } })),
      el('input', { type: 'color', id: 'editColor', title: 'Custom colour', value: u.color })
    );
    $('#editColor').addEventListener('input', (e) => { editColor = e.target.value; renderEditPreview(); });
    renderEditPreview();
    $('#profileDlg').close();
    $('#editDlg').showModal();
  } catch (e) { alert(e.message); }
}

$('#profileEdit').addEventListener('click', openEdit);
$('#editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.submitter && e.submitter.value === 'cancel') return $('#editDlg').close();
  try {
    const u = await api('/me', { method: 'PATCH', body: { color: editColor, bio: $('#editBio').value, status: $('#editStatus').value } });
    Object.assign(state.me, u);
    paintMe();
    $('#editDlg').close();
  } catch (err) { alert(err.message); }
});
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-profile]');
  if (t) showProfile(Number(t.dataset.profile));
});

// ---------- server about, settings, roles ----------
const PERMS = [
  [1, 'Manage channels', 'Create text and voice channels'],
  [2, 'Manage server', 'Rename the server, edit its description, make a new invite code'],
  [4, 'Manage roles', 'Create roles and give them to members'],
];
let settingsTab = 'overview';
const run = (p) => p.catch((e) => alert(e.message));
const roleStyle = (m) => {
  const r = state.roles.find((x) => (m.roles || []).includes(x.id));
  return r ? `color:${r.color}` : '';
};

async function refreshServer() {
  const data = await api('/servers/' + state.serverId);
  state.server = data.server;
  state.roles = data.roles;
  state.perms = data.perms;
  state.members = data.members;
  data.channels.forEach((c) => { if (!state.channels.some((x) => x.id === c.id)) state.channels.push(c); });
  $('#serverName').textContent = data.server.name;
  $('#addChannel').hidden = !(state.perms & 1);
  $('#settingsBtn').hidden = !(state.perms & 6);
  renderMembers();
  renderChannels();
  if ($('#settingsDlg').open) renderSettings();
}

function showAbout() {
  if (state.view !== 'server' || !state.server) return;
  const s = state.server;
  const owner = state.members.find((m) => m.id === s.owner_id);
  const online = state.members.filter((m) => m.online).length;
  $('#aboutBody').replaceChildren(
    el('h3', {}, s.name),
    el('p', {}, s.description || 'No description yet.'),
    el('dl', { class: 'facts' },
      el('dt', {}, 'Members'), el('dd', {}, `${state.members.length} total, ${online} online`),
      el('dt', {}, 'Owner'), el('dd', {}, owner ? owner.username : 'Unknown'),
      el('dt', {}, 'Created'), el('dd', {}, new Date(s.created).toLocaleDateString()),
      el('dt', {}, 'Invite code'), el('dd', {}, s.invite))
  );
  $('#aboutDlg').showModal();
}

function openSettings() {
  settingsTab = state.perms & 2 ? 'overview' : 'roles';
  renderSettings();
  $('#settingsDlg').showModal();
}

function renderSettings() {
  const tabs = [];
  if (state.perms & 2) tabs.push(['overview', 'Overview']);
  if (state.perms & 4) tabs.push(['roles', 'Roles'], ['members', 'Members']);
  $('#settingsTabs').replaceChildren(...tabs.map(([k, label]) =>
    el('button', { class: 'tab' + (settingsTab === k ? ' active' : ''), type: 'button', onclick: () => { settingsTab = k; renderSettings(); } }, label)));
  $('#settingsBody').replaceChildren({ overview: overviewPane, roles: rolesPane, members: membersPane }[settingsTab]());
}

function overviewPane() {
  const name = el('input', { value: state.server.name, maxlength: '40' });
  const desc = el('textarea', { rows: '3', maxlength: '200' });
  desc.value = state.server.description || '';
  const box = el('div', {},
    el('label', {}, 'Server name', name),
    el('label', {}, 'Description', desc),
    el('div', { class: 'row' },
      el('button', { class: 'primary', type: 'button', onclick: () => run(api('/servers/' + state.serverId, { method: 'PATCH', body: { name: name.value, description: desc.value } })) }, 'Save changes')),
    el('p', {}, 'Invite code: ' + state.server.invite),
    el('div', { class: 'row' }, el('button', { type: 'button', onclick: () => run(api(`/servers/${state.serverId}/invite/reset`, { method: 'POST' })) }, 'Make a new invite code'))
  );
  if (state.server.owner_id === state.me.id) {
    box.append(el('div', { class: 'row' }, el('button', { class: 'danger', type: 'button', onclick: () => {
      if (confirm(`Delete ${state.server.name} for everyone? This cannot be undone.`)) run(api('/servers/' + state.serverId, { method: 'DELETE' }));
    } }, 'Delete server')));
  }
  return box;
}

function rolesPane() {
  const add = () => run(api(`/servers/${state.serverId}/roles`, { method: 'POST', body: { name: 'New role', color: '#6670f5', perms: 0 } }));
  const box = el('div', {}, el('p', {}, 'Roles give members a name colour and powers. The server owner always has every power.'), el('div', { class: 'row' }, el('button', { class: 'primary', type: 'button', onclick: add }, 'New role')));
  if (!state.roles.length) box.append(el('p', {}, 'No roles yet. Roles give members a name colour and powers.'));
  state.roles.forEach((r) => box.append(roleCard(r)));
  return box;
}

function roleCard(r) {
  let colorVal = r.color;
  const count = state.members.filter((m) => (m.roles || []).includes(r.id)).length;
  const name = el('input', { value: r.name, maxlength: '24' });
  const preview = el('span', { class: 'rolepill' });
  const paint = () => {
    preview.textContent = name.value.trim() || 'Role';
    preview.style.color = colorVal;
    preview.style.borderColor = colorVal;
  };
  const custom = el('input', { type: 'color', value: r.color, title: 'Custom colour' });
  const swatches = PALETTE.map((c) => el('button', {
    type: 'button', class: 'swatch', style: `background:${c}`, 'aria-label': 'Colour ' + c,
    onclick: () => { colorVal = c; custom.value = c; paint(); },
  }));
  custom.addEventListener('input', () => { colorVal = custom.value; paint(); });
  name.addEventListener('input', paint);
  const checks = PERMS.map(([bit, label, hint]) => {
    const c = el('input', { type: 'checkbox' });
    c.checked = (r.perms & bit) !== 0;
    c.disabled = (state.perms & bit) === 0;
    return [bit, c, label, hint];
  });
  const save = () => run(api(`/servers/${state.serverId}/roles/${r.id}`, {
    method: 'PATCH',
    body: { name: name.value, color: colorVal, perms: checks.reduce((a, [bit, c]) => a | (c.checked ? bit : 0), 0) },
  }));
  const remove = () => {
    if (confirm(`Delete the role "${r.name}"? Members who have it will lose it.`)) {
      run(api(`/servers/${state.serverId}/roles/${r.id}`, { method: 'DELETE' }));
    }
  };
  paint();
  return el('div', { class: 'rolecard' },
    el('div', { class: 'rolehead' }, preview, el('small', {}, count === 1 ? '1 member' : `${count} members`)),
    el('label', {}, 'Role name', name),
    el('div', { class: 'swatches' }, ...swatches, custom),
    el('div', { class: 'perms' }, ...checks.map(([, c, label, hint]) =>
      el('label', { class: 'chk' }, c, el('span', {}, el('b', {}, label), el('small', {}, hint))))),
    el('div', { class: 'row' },
      el('button', { class: 'danger', type: 'button', onclick: remove }, 'Delete'),
      el('button', { class: 'primary', type: 'button', onclick: save }, 'Save role'))
  );
}

function membersPane() {
  const box = el('div', {});
  if (!state.roles.length) box.append(el('p', {}, 'Create a role first, then give it to people here.'));
  state.members.forEach((m) => {
    const chips = state.roles.map((r) => {
      const has = (m.roles || []).includes(r.id);
      const next = has ? m.roles.filter((x) => x !== r.id) : [...(m.roles || []), r.id];
      return el('button', { class: 'chip' + (has ? ' mine' : ''), type: 'button', style: has ? `border-color:${r.color}` : '',
        onclick: () => run(api(`/servers/${state.serverId}/members/${m.id}/roles`, { method: 'PUT', body: { roleIds: next } })) }, r.name);
    });
    box.append(el('div', { class: 'frow' }, avatar(m.username, m.color), el('div', { class: 'finfo' }, el('b', { style: roleStyle(m) }, m.username)), el('div', { class: 'chips' }, ...chips)));
  });
  return box;
}

$('#serverName').addEventListener('click', showAbout);
$('#settingsBtn').addEventListener('click', openSettings);
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-close]');
  if (c) c.closest('dialog').close();
});

// profile picture: crop to a square, shrink to 128px, send as a small JPEG
$('#avatarPick').addEventListener('click', () => $('#avatarFile').click());
$('#avatarClear').addEventListener('click', () => run(api('/me/avatar', { method: 'DELETE' })));
$('#avatarFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const bmp = await createImageBitmap(f);
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const s = Math.min(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 128, 128);
    await api('/me/avatar', { method: 'PUT', body: { image: c.toDataURL('image/jpeg', 0.85) } });
  } catch (err) { alert(err.message || 'Could not use that image.'); }
});

// ---------- buttons ----------
$('#choiceCreate').addEventListener('click', async () => {
  $('#choiceDlg').close();
  const name = await ask('Create a server', 'Server name');
  if (!name) return;
  try {
    const s = await api('/servers', { method: 'POST', body: { name } });
    state.servers.push(s);
    selectServer(s.id);
  } catch (e) { alert(e.message); }
});

$('#choiceJoin').addEventListener('click', async () => {
  $('#choiceDlg').close();
  const code = await ask('Join a server', 'Invite code');
  if (!code) return;
  try {
    const s = await api('/servers/join', { method: 'POST', body: { code } });
    if (!state.servers.some((x) => x.id === s.id)) state.servers.push({ id: s.id, name: s.name, owner_id: s.owner_id });
    selectServer(s.id);
  } catch (e) { alert(e.message); }
});

$('#addChannel').addEventListener('click', async () => {
  const name = await ask('New channel', 'Channel name');
  if (!name) return;
  try {
    const c = await api(`/servers/${state.serverId}/channels`, { method: 'POST', body: { name } });
    if (!state.channels.some((x) => x.id === c.id)) state.channels.push(c);
    selectChannel(c.id);
  } catch (e) { alert(e.message); }
});

$('#inviteBtn').addEventListener('click', async () => {
  const code = state.server.invite;
  try {
    await navigator.clipboard.writeText(code);
    const b = $('#inviteBtn');
    b.textContent = 'Copied!';
    setTimeout(() => (b.textContent = 'Invite'), 1500);
  } catch {
    prompt('Share this invite code:', code);
  }
});

// ---------- themes ----------
const THEMES = [['dusk', 'Dusk'], ['teal', 'Teal'], ['midnight', 'Midnight'], ['daylight', 'Daylight']];
function applyTheme(t) {
  if (!THEMES.some(([k]) => k === t)) t = 'dusk';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('nook_theme', t); } catch {}
  $('#themeBtn').textContent = THEMES.find(([k]) => k === t)[1];
}
$('#themeBtn').addEventListener('click', () => {
  const i = THEMES.findIndex(([k]) => k === document.documentElement.dataset.theme);
  applyTheme(THEMES[(i + 1) % THEMES.length][0]);
});
let savedTheme = 'dusk';
try { savedTheme = localStorage.getItem('nook_theme') || 'dusk'; } catch {}
applyTheme(savedTheme);

// ---------- go ----------
renderAuthMode();
if (state.token) start();
else $('#auth').hidden = false;
