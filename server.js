const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DUMMY_HASH = bcrypt.hashSync('nook-dummy-password', 12); // keeps failed logins as slow as real ones
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Signing key for login tokens. Set JWT_SECRET yourself in production,
// otherwise one is generated once and saved next to the database.
const secretFile = path.join(DATA_DIR, 'jwt.secret');
const JWT_SECRET =
  process.env.JWT_SECRET ||
  (fs.existsSync(secretFile)
    ? fs.readFileSync(secretFile, 'utf8')
    : (() => {
        const s = crypto.randomBytes(48).toString('hex');
        fs.writeFileSync(secretFile, s, { mode: 0o600 });
        return s;
      })());

// ---------- Database ----------
const db = new Database(path.join(DATA_DIR, 'nook.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  hash TEXT NOT NULL,
  color TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  invite TEXT NOT NULL UNIQUE,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, user_id)
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
`);
// Upgrade older databases in place.
try { db.exec('ALTER TABLE servers ADD COLUMN dm INTEGER NOT NULL DEFAULT 0'); } catch {}
for (const sql of ["ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''", "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT ''", 'ALTER TABLE channels ADD COLUMN voice INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE users ADD COLUMN avatar BLOB', "ALTER TABLE servers ADD COLUMN description TEXT NOT NULL DEFAULT ''"]) {
  try { db.exec(sql); } catch {}
}
db.exec(`
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL, color TEXT NOT NULL, perms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS member_roles (
  server_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);
`);
db.exec('CREATE TABLE IF NOT EXISTS friends (a INTEGER NOT NULL, b INTEGER NOT NULL, status TEXT NOT NULL, PRIMARY KEY (a, b))');
for (const col of ["reactions TEXT NOT NULL DEFAULT '{}'", 'edited INTEGER NOT NULL DEFAULT 0']) {
  try { db.exec('ALTER TABLE messages ADD COLUMN ' + col); } catch {}
}

const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT id, username, color, status FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (username, hash, color, created) VALUES (?, ?, ?, ?)'),
  userServers: db.prepare(
    `SELECT s.id, s.name, s.owner_id FROM servers s
     JOIN members m ON m.server_id = s.id WHERE m.user_id = ? AND s.dm = 0 ORDER BY s.id`
  ),
  serverById: db.prepare('SELECT id, name, invite, owner_id, description, created, dm FROM servers WHERE id = ?'),
  serverByInvite: db.prepare('SELECT id, name, owner_id FROM servers WHERE invite = ? AND dm = 0'),
  insertServer: db.prepare('INSERT INTO servers (name, invite, owner_id, created) VALUES (?, ?, ?, ?)'),
  allServerIds: db.prepare('SELECT server_id AS id FROM members WHERE user_id = ?'),
  addMember: db.prepare('INSERT OR IGNORE INTO members (server_id, user_id) VALUES (?, ?)'),
  isMember: db.prepare('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?'),
  members: db.prepare(
    `SELECT u.id, u.username, u.color, u.status FROM users u
     JOIN members m ON m.user_id = u.id WHERE m.server_id = ? ORDER BY u.username COLLATE NOCASE`
  ),
  channels: db.prepare('SELECT id, server_id, name, voice FROM channels WHERE server_id = ? ORDER BY id'),
  channelById: db.prepare('SELECT id, server_id, name, voice FROM channels WHERE id = ?'),
  insertChannel: db.prepare('INSERT INTO channels (server_id, name, created) VALUES (?, ?, ?)'),
  insertVoice: db.prepare('INSERT INTO channels (server_id, name, created, voice) VALUES (?, ?, ?, 1)'),
  messagesLatest: db.prepare(
    `SELECT m.id, m.channel_id AS channelId, m.content, m.created, m.reactions, m.edited,
            u.id AS authorId, u.username, u.color
     FROM messages m JOIN users u ON u.id = m.user_id
     WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT 50`
  ),
  messagesBefore: db.prepare(
    `SELECT m.id, m.channel_id AS channelId, m.content, m.created, m.reactions, m.edited,
            u.id AS authorId, u.username, u.color
     FROM messages m JOIN users u ON u.id = m.user_id
     WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT 50`
  ),
  insertMessage: db.prepare('INSERT INTO messages (channel_id, user_id, content, created) VALUES (?, ?, ?, ?)'),
  messageById: db.prepare('SELECT id, channel_id, user_id FROM messages WHERE id = ?'),
  deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
  messageFull: db.prepare('SELECT * FROM messages WHERE id = ?'),
  updateContent: db.prepare('UPDATE messages SET content = ?, edited = 1 WHERE id = ?'),
  setReactions: db.prepare('UPDATE messages SET reactions = ? WHERE id = ?'),
};

const COLORS = ['#f2c14e', '#6fd3c3', '#ff8a7a', '#9db4ff', '#c79bff', '#8fd77a', '#ffb36b', '#6cc3f0'];
const shape = (r) => ({
  id: r.id,
  channelId: r.channelId,
  content: r.content,
  created: r.created,
  reactions: JSON.parse(r.reactions || '{}'),
  edited: !!r.edited,
  author: { id: r.authorId, username: r.username, color: r.color },
});

function createServer(name, ownerId) {
  const invite = crypto.randomBytes(5).toString('hex');
  const now = Date.now();
  const tx = db.transaction(() => {
    const id = q.insertServer.run(name, invite, ownerId, now).lastInsertRowid;
    q.addMember.run(id, ownerId);
    q.insertChannel.run(id, 'general', now);
    q.insertChannel.run(id, 'random', now);
    q.insertVoice.run(id, 'Lounge', now);
    return id;
  });
  return q.serverById.get(tx());
}

const cleanChannelName = (s) =>
  String(s || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);

// ---------- App + realtime ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  });
  next();
});
// Overall API limit: 600 requests a minute per IP (login has its own stricter limit).
const hits = new Map();
setInterval(() => { hits.clear(); attempts.clear(); }, 10 * 60 * 1000).unref();
app.use('/api', (req, res, next) => {
  const now = Date.now();
  const list = (hits.get(req.ip) || []).filter((t) => now - t < 60000);
  if (list.length >= 600) return res.status(429).json({ error: 'Too many requests. Slow down a little.' });
  list.push(now);
  hits.set(req.ip, list);
  next();
});
app.use(express.json({ limit: '80kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const online = new Map(); // userId -> number of open sockets
const voiceRooms = new Map(); // channelId -> Map(socketId -> user)

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try {
    const payload = jwt.verify(h.replace(/^Bearer /, ''), JWT_SECRET);
    if (!q.userById.get(payload.id)) throw new Error('gone');
    req.userId = payload.id;
    next();
  } catch {
    res.status(401).json({ error: 'Please log in again.' });
  }
}

const sign = (id) => jwt.sign({ id }, JWT_SECRET, { expiresIn: '30d' });

// Basic brute-force guard: max 10 auth attempts per minute per IP.
const attempts = new Map();
function limitAuth(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < 60000);
  if (list.length >= 10) return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
  list.push(now);
  attempts.set(key, list);
  next();
}

app.post('/api/signup', limitAuth, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[A-Za-z0-9_.-]{3,20}$/.test(username))
    return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, _ . -' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be 8-128 characters.' });
  if (q.userByName.get(username)) return res.status(409).json({ error: 'That username is taken.' });
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const id = q.insertUser.run(username, bcrypt.hashSync(password, 12), color, Date.now()).lastInsertRowid;
  res.json({ token: sign(id) });
});

app.post('/api/login', limitAuth, (req, res) => {
  const user = q.userByName.get(String(req.body.username || '').trim());
  const passOk = bcrypt.compareSync(String(req.body.password || ''), user ? user.hash : DUMMY_HASH);
  if (!user || !passOk)
    return res.status(401).json({ error: 'Wrong username or password.' });
  res.json({ token: sign(user.id) });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ user: q.userById.get(req.userId), servers: q.userServers.all(req.userId) });
});

app.post('/api/servers', auth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Give your server a name.' });
  const s = createServer(name, req.userId);
  io.in('user:' + req.userId).socketsJoin('server:' + s.id);
  res.json({ id: s.id, name: s.name, owner_id: s.owner_id });
});

app.post('/api/servers/join', auth, (req, res) => {
  const s = q.serverByInvite.get(String(req.body.code || '').trim().toLowerCase());
  if (!s) return res.status(404).json({ error: 'No server matches that invite code.' });
  const fresh = !q.isMember.get(s.id, req.userId);
  q.addMember.run(s.id, req.userId);
  io.in('user:' + req.userId).socketsJoin('server:' + s.id);
  if (fresh) io.to('server:' + s.id).emit('member:new', { serverId: s.id });
  res.json(s);
});

app.get('/api/servers/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  if (!q.isMember.get(id, req.userId)) return res.status(403).json({ error: 'You are not in that server.' });
  const s = q.serverById.get(id);
  const mr = db.prepare('SELECT user_id, role_id FROM member_roles WHERE server_id = ?').all(id);
  const members = q.members.all(id).map((m) => ({ ...m, online: online.has(m.id), roles: mr.filter((x) => x.user_id === m.id).map((x) => x.role_id) }));
  const channels = q.channels.all(id);
  const voice = {};
  channels.filter((c) => c.voice).forEach((c) => { const r = voiceRooms.get(c.id); if (r) voice[c.id] = [...r.values()]; });
  const roles = db.prepare('SELECT id, name, color, perms FROM roles WHERE server_id = ? ORDER BY id').all(id);
  res.json({ server: s, channels, members, voice, roles, perms: permsFor(id, req.userId) });
});

app.post('/api/servers/:id/channels', auth, (req, res) => {
  const id = Number(req.params.id);
  const s = q.serverById.get(id);
  if (!s || !can(id, req.userId, P.CHANNELS)) return res.status(403).json({ error: "You don't have permission to add channels." });
  const name = cleanChannelName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Channel names use letters, numbers, - and _.' });
  const cid = (req.body.voice ? q.insertVoice : q.insertChannel).run(id, name, Date.now()).lastInsertRowid;
  const channel = q.channelById.get(cid);
  io.to('server:' + id).emit('channel:new', channel);
  res.json(channel);
});

app.get('/api/channels/:id/messages', auth, (req, res) => {
  const ch = q.channelById.get(Number(req.params.id));
  if (!ch || !q.isMember.get(ch.server_id, req.userId)) return res.status(403).json({ error: 'No access.' });
  const before = Number(req.query.before);
  const rows = before ? q.messagesBefore.all(ch.id, before) : q.messagesLatest.all(ch.id);
  res.json(rows.reverse().map(shape));
});

app.delete('/api/messages/:id', auth, (req, res) => {
  const m = q.messageById.get(Number(req.params.id));
  if (!m || m.user_id !== req.userId) return res.status(403).json({ error: 'You can only delete your own messages.' });
  q.deleteMessage.run(m.id);
  const ch = q.channelById.get(m.channel_id);
  io.to('server:' + ch.server_id).emit('message:deleted', { id: m.id, channelId: m.channel_id });
  res.json({ ok: true });
});

app.patch('/api/messages/:id', auth, (req, res) => {
  const m = q.messageById.get(Number(req.params.id));
  const content = String(req.body.content || '').trim().slice(0, 2000);
  if (!m || m.user_id !== req.userId) return res.status(403).json({ error: 'You can only edit your own messages.' });
  if (!content) return res.status(400).json({ error: 'A message cannot be empty.' });
  q.updateContent.run(content, m.id);
  const ch = q.channelById.get(m.channel_id);
  io.to('server:' + ch.server_id).emit('message:updated', { id: m.id, channelId: m.channel_id, content });
  res.json({ ok: true });
});

const EMOJI = ['👍', '❤️', '😂', '🎉', '😮', '👀'];
app.post('/api/messages/:id/react', auth, (req, res) => {
  const m = q.messageFull.get(Number(req.params.id));
  const ch = m && q.channelById.get(m.channel_id);
  const emoji = req.body.emoji;
  if (!ch || !q.isMember.get(ch.server_id, req.userId) || !EMOJI.includes(emoji))
    return res.status(400).json({ error: 'Could not react.' });
  const r = JSON.parse(m.reactions || '{}');
  const list = r[emoji] || [];
  const i = list.indexOf(req.userId);
  if (i >= 0) list.splice(i, 1); else list.push(req.userId);
  if (list.length) r[emoji] = list; else delete r[emoji];
  q.setReactions.run(JSON.stringify(r), m.id);
  io.to('server:' + ch.server_id).emit('message:reactions', { id: m.id, channelId: ch.id, reactions: r });
  res.json({ ok: true });
});

// ---------- Roles, permissions and server settings ----------
const P = { CHANNELS: 1, SERVER: 2, ROLES: 4 };
const permsFor = (sid, uid) => {
  const s = q.serverById.get(sid);
  if (!s) return 0;
  if (s.owner_id === uid) return 7;
  return db.prepare('SELECT r.perms FROM roles r JOIN member_roles mr ON mr.role_id = r.id WHERE mr.server_id = ? AND mr.user_id = ?')
    .all(sid, uid).reduce((a, r) => a | r.perms, 0);
};
const can = (sid, uid, bit) => (permsFor(sid, uid) & bit) !== 0;
const guard = (bit) => (req, res, next) => {
  const sid = Number(req.params.id);
  const s = q.serverById.get(sid);
  if (!s || s.dm || !can(sid, req.userId, bit)) return res.status(403).json({ error: "You don't have permission to do that." });
  req.sid = sid;
  next();
};
const pushServer = (sid) => io.to('server:' + sid).emit('server:update', { serverId: sid, name: q.serverById.get(sid).name });

function roleFields(body) {
  const name = String(body.name || '').trim().slice(0, 24);
  const color = String(body.color || '').toLowerCase();
  if (!name || !/^#[0-9a-f]{6}$/.test(color)) return null;
  return { name, color, perms: (Number(body.perms) || 0) & 7 };
}
const noEscalation = (req, perms) => (perms & ~permsFor(req.sid, req.userId)) === 0;

app.patch('/api/servers/:id', auth, guard(P.SERVER), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'A server needs a name.' });
  db.prepare('UPDATE servers SET name = ?, description = ? WHERE id = ?').run(name, String(req.body.description || '').trim().slice(0, 200), req.sid);
  pushServer(req.sid);
  res.json({ ok: true });
});

app.post('/api/servers/:id/invite/reset', auth, guard(P.SERVER), (req, res) => {
  db.prepare('UPDATE servers SET invite = ? WHERE id = ?').run(crypto.randomBytes(5).toString('hex'), req.sid);
  pushServer(req.sid);
  res.json({ ok: true });
});

app.delete('/api/servers/:id', auth, (req, res) => {
  const s = q.serverById.get(Number(req.params.id));
  if (!s || s.dm || s.owner_id !== req.userId) return res.status(403).json({ error: 'Only the owner can delete a server.' });
  db.prepare('DELETE FROM servers WHERE id = ?').run(s.id);
  io.to('server:' + s.id).emit('server:deleted', { serverId: s.id });
  io.in('server:' + s.id).socketsLeave('server:' + s.id);
  res.json({ ok: true });
});

app.post('/api/servers/:id/roles', auth, guard(P.ROLES), (req, res) => {
  const f = roleFields(req.body);
  if (!f) return res.status(400).json({ error: 'A role needs a name and a valid colour.' });
  if (!noEscalation(req, f.perms)) return res.status(403).json({ error: "You can't give powers you don't have." });
  db.prepare('INSERT INTO roles (server_id, name, color, perms) VALUES (?, ?, ?, ?)').run(req.sid, f.name, f.color, f.perms);
  pushServer(req.sid);
  res.json({ ok: true });
});

app.patch('/api/servers/:id/roles/:rid', auth, guard(P.ROLES), (req, res) => {
  const f = roleFields(req.body);
  if (!f) return res.status(400).json({ error: 'A role needs a name and a valid colour.' });
  if (!noEscalation(req, f.perms)) return res.status(403).json({ error: "You can't give powers you don't have." });
  const r = db.prepare('UPDATE roles SET name = ?, color = ?, perms = ? WHERE id = ? AND server_id = ?').run(f.name, f.color, f.perms, Number(req.params.rid), req.sid);
  if (!r.changes) return res.status(404).json({ error: 'No such role.' });
  pushServer(req.sid);
  res.json({ ok: true });
});

app.delete('/api/servers/:id/roles/:rid', auth, guard(P.ROLES), (req, res) => {
  db.prepare('DELETE FROM roles WHERE id = ? AND server_id = ?').run(Number(req.params.rid), req.sid);
  pushServer(req.sid);
  res.json({ ok: true });
});

app.put('/api/servers/:id/members/:uid/roles', auth, guard(P.ROLES), (req, res) => {
  const uid = Number(req.params.uid);
  if (!q.isMember.get(req.sid, uid)) return res.status(404).json({ error: 'Not a member.' });
  const ids = (Array.isArray(req.body.roleIds) ? req.body.roleIds : []).map(Number);
  const chosen = db.prepare('SELECT id, perms FROM roles WHERE server_id = ?').all(req.sid).filter((r) => ids.includes(r.id));
  if (chosen.some((r) => !noEscalation(req, r.perms))) return res.status(403).json({ error: "You can't assign a role more powerful than your own." });
  db.transaction(() => {
    db.prepare('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?').run(req.sid, uid);
    chosen.forEach((r) => db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(req.sid, uid, r.id));
  })();
  pushServer(req.sid);
  res.json({ ok: true });
});

// ---------- Profiles ----------
function pushProfile(uid) {
  const u = q.userById.get(uid);
  q.allServerIds.all(uid).forEach((s) => io.to('server:' + s.id).emit('profile:update', u));
  db.prepare("SELECT CASE WHEN a = ? THEN b ELSE a END AS id FROM friends WHERE (a = ? OR b = ?) AND status = 'accepted'")
    .all(uid, uid, uid)
    .forEach((f) => io.to('user:' + f.id).emit('profile:update', u));
  io.to('user:' + uid).emit('profile:update', u);
  return u;
}

app.put('/api/me/avatar', auth, (req, res) => {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(req.body.image || ''));
  const buf = m && Buffer.from(m[1], 'base64');
  if (!buf || buf.length > 60000 || buf[0] !== 0xff || buf[1] !== 0xd8) return res.status(400).json({ error: 'That image could not be used. Try a different one.' });
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(buf, req.userId);
  res.json(pushProfile(req.userId));
});

app.delete('/api/me/avatar', auth, (req, res) => {
  db.prepare('UPDATE users SET avatar = NULL WHERE id = ?').run(req.userId);
  res.json(pushProfile(req.userId));
});

// Public on purpose: <img> tags cannot send login headers.
app.get('/api/avatars/:username', (req, res) => {
  const row = db.prepare('SELECT avatar FROM users WHERE username = ?').get(String(req.params.username));
  if (!row || !row.avatar) return res.status(404).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'none'" }).send(row.avatar);
});

app.patch('/api/me', auth, (req, res) => {
  const color = String(req.body.color || '').toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) return res.status(400).json({ error: 'Pick a valid colour.' });
  const bio = String(req.body.bio || '').trim().slice(0, 190);
  const status = String(req.body.status || '').trim().slice(0, 50);
  db.prepare('UPDATE users SET color = ?, bio = ?, status = ? WHERE id = ?').run(color, bio, status, req.userId);
  const u = pushProfile(req.userId);
  res.json(u);
});

app.get('/api/users/:id', auth, (req, res) => {
  const u = db.prepare('SELECT id, username, color, bio, status, created FROM users WHERE id = ?').get(Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'No such user.' });
  res.json({ ...u, online: online.has(u.id) });
});

// ---------- Friends + direct messages ----------
const withOnline = (ids) => ids.map((id) => ({ ...q.userById.get(id), online: online.has(id) }));
const pushFriends = (...ids) => ids.forEach((id) => io.to('user:' + id).emit('friends:update'));
const areFriends = (a, b) =>
  !!db.prepare("SELECT 1 FROM friends WHERE status = 'accepted' AND ((a = ? AND b = ?) OR (a = ? AND b = ?))").get(a, b, b, a);

app.get('/api/friends', auth, (req, res) => {
  const me = req.userId;
  const rows = db.prepare('SELECT a, b, status FROM friends WHERE a = ? OR b = ?').all(me, me);
  const other = (r) => (r.a === me ? r.b : r.a);
  res.json({
    friends: withOnline(rows.filter((r) => r.status === 'accepted').map(other)),
    incoming: withOnline(rows.filter((r) => r.status === 'pending' && r.b === me).map((r) => r.a)),
    outgoing: withOnline(rows.filter((r) => r.status === 'pending' && r.a === me).map((r) => r.b)),
  });
});

app.post('/api/friends', auth, (req, res) => {
  const me = req.userId;
  const t = q.userByName.get(String(req.body.username || '').trim());
  if (!t) return res.status(404).json({ error: 'No user with that username.' });
  if (t.id === me) return res.status(400).json({ error: "That's you!" });
  const ex = db.prepare('SELECT a, b, status FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)').get(me, t.id, t.id, me);
  if (ex && ex.status === 'accepted') return res.status(400).json({ error: `You and ${t.username} are already friends.` });
  if (ex && ex.a === me) return res.status(400).json({ error: 'Request already sent.' });
  if (ex) db.prepare("UPDATE friends SET status = 'accepted' WHERE a = ? AND b = ?").run(t.id, me);
  else db.prepare("INSERT INTO friends (a, b, status) VALUES (?, ?, 'pending')").run(me, t.id);
  pushFriends(me, t.id);
  res.json({ ok: true, accepted: !!ex, username: t.username });
});

app.post('/api/friends/:id/accept', auth, (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare("UPDATE friends SET status = 'accepted' WHERE a = ? AND b = ? AND status = 'pending'").run(id, req.userId);
  if (!r.changes) return res.status(404).json({ error: 'No such request.' });
  pushFriends(req.userId, id);
  res.json({ ok: true });
});

app.delete('/api/friends/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)').run(req.userId, id, id, req.userId);
  pushFriends(req.userId, id);
  res.json({ ok: true });
});

// A DM is a private two-person "server" (dm = 1) with a single channel, so
// messages, reactions, edits and realtime all reuse the normal channel code.
app.post('/api/dms', auth, (req, res) => {
  const me = req.userId;
  const other = Number(req.body.userId);
  if (!q.userById.get(other) || !areFriends(me, other)) return res.status(403).json({ error: 'You can only message friends.' });
  let row = db.prepare(
    `SELECT s.id FROM servers s
     JOIN members x ON x.server_id = s.id AND x.user_id = ?
     JOIN members y ON y.server_id = s.id AND y.user_id = ? WHERE s.dm = 1`
  ).get(me, other);
  let sid = row && row.id;
  if (!sid) {
    sid = db.transaction(() => {
      const now = Date.now();
      const id = db.prepare("INSERT INTO servers (name, invite, owner_id, created, dm) VALUES ('', ?, ?, ?, 1)")
        .run(crypto.randomBytes(8).toString('hex'), me, now).lastInsertRowid;
      q.addMember.run(id, me);
      q.addMember.run(id, other);
      q.insertChannel.run(id, 'dm', now);
      return id;
    })();
    io.in('user:' + me).socketsJoin('server:' + sid);
    io.in('user:' + other).socketsJoin('server:' + sid);
    pushFriends(me, other);
  }
  res.json({ serverId: sid, channelId: q.channels.all(sid)[0].id });
});

app.get('/api/dms', auth, (req, res) => {
  const me = req.userId;
  const rows = db.prepare(
    `SELECT s.id AS serverId, y.user_id AS other, c.id AS channelId FROM servers s
     JOIN members x ON x.server_id = s.id AND x.user_id = ?
     JOIN members y ON y.server_id = s.id AND y.user_id != ?
     JOIN channels c ON c.server_id = s.id WHERE s.dm = 1 ORDER BY s.id DESC`
  ).all(me, me);
  res.json(rows.map((r) => ({ serverId: r.serverId, channelId: r.channelId, user: withOnline([r.other])[0] })));
});

// ---------- Voice rooms (signalling only; audio flows peer to peer) ----------
function voiceBroadcast(cid) {
  const ch = q.channelById.get(cid);
  if (!ch) return;
  const users = [...(voiceRooms.get(cid) || new Map()).values()];
  io.to('server:' + ch.server_id).emit('voice:state', { channelId: cid, serverId: ch.server_id, users });
}

// ---------- Sockets ----------
io.use((socket, next) => {
  try {
    const payload = jwt.verify(socket.handshake.auth.token || '', JWT_SECRET);
    const user = q.userById.get(payload.id);
    if (!user) throw new Error('gone');
    socket.user = user;
    next();
  } catch {
    next(new Error('auth'));
  }
});

io.on('connection', (socket) => {
  const user = socket.user;
  const servers = q.allServerIds.all(user.id);
  socket.join('user:' + user.id);
  servers.forEach((s) => socket.join('server:' + s.id));

  const count = (online.get(user.id) || 0) + 1;
  online.set(user.id, count);
  if (count === 1) servers.forEach((s) => io.to('server:' + s.id).emit('presence', { userId: user.id, online: true }));

  let recent = [];
  socket.on('message:send', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const now = Date.now();
    recent = recent.filter((t) => now - t < 5000);
    if (recent.length >= 8) return reply({ error: 'Slow down a little.' });
    const content = String((data && data.content) || '').trim().slice(0, 2000);
    const ch = q.channelById.get(Number(data && data.channelId));
    if (!content || !ch || !q.isMember.get(ch.server_id, user.id)) return reply({ error: 'Could not send.' });
    recent.push(now);
    const id = q.insertMessage.run(ch.id, user.id, content, now).lastInsertRowid;
    const msg = { id, channelId: ch.id, serverId: ch.server_id, content, created: now, reactions: {}, edited: false, author: q.userById.get(user.id) };
    io.to('server:' + ch.server_id).emit('message:new', msg);
    reply({ ok: true });
  });

  socket.on('typing', (data) => {
    const ch = q.channelById.get(Number(data && data.channelId));
    if (!ch || !q.isMember.get(ch.server_id, user.id)) return;
    socket.to('server:' + ch.server_id).emit('typing', { channelId: ch.id, username: user.username });
  });


  function leaveVoice() {
    const cid = socket.voiceChannel;
    if (!cid) return;
    const room = voiceRooms.get(cid);
    if (room) {
      room.delete(socket.id);
      if (!room.size) voiceRooms.delete(cid);
    }
    socket.to('voice:' + cid).emit('voice:left', { id: socket.id });
    socket.leave('voice:' + cid);
    socket.voiceChannel = null;
    voiceBroadcast(cid);
  }

  socket.on('voice:join', (data) => {
    const ch = q.channelById.get(Number(data && data.channelId));
    if (!ch || !ch.voice || !q.isMember.get(ch.server_id, user.id)) return;
    leaveVoice();
    const room = voiceRooms.get(ch.id) || new Map();
    if (room.size >= 8) return socket.emit('voice:full');
    const peers = [...room.keys()];
    room.set(socket.id, q.userById.get(user.id));
    voiceRooms.set(ch.id, room);
    socket.join('voice:' + ch.id);
    socket.voiceChannel = ch.id;
    socket.emit('voice:peers', peers);
    voiceBroadcast(ch.id);
  });
  socket.on('voice:leave', leaveVoice);
  socket.on('voice:signal', (data) => {
    const target = io.sockets.sockets.get(data && data.to);
    if (socket.voiceChannel && target && target.voiceChannel === socket.voiceChannel) {
      target.emit('voice:signal', { from: socket.id, data: data.data });
    }
  });

  socket.on('disconnect', () => {
    leaveVoice();
    const left = (online.get(user.id) || 1) - 1;
    if (left > 0) return online.set(user.id, left);
    online.delete(user.id);
    q.allServerIds.all(user.id).forEach((s) => io.to('server:' + s.id).emit('presence', { userId: user.id, online: false }));
  });
});

server.listen(PORT, () => console.log(`Nook is running at http://localhost:${PORT}`));

// Safe database copies: now, then once a day (newest 14 kept in backups/).
const { runBackup } = require('./backup');
const autoBackup = () => runBackup(db).catch((e) => console.error('Backup failed:', e.message));
autoBackup();
setInterval(autoBackup, 24 * 60 * 60 * 1000).unref();
