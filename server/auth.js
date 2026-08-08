'use strict';
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

// =====================================================================
//  Хранилище сессий в той же SQLite. Готовых пакетов не тянем:
//  здесь всего три операции, а взамен вход переживает перезапуск сервера.
// =====================================================================
class SqliteStore extends session.Store {
  constructor() {
    super();
    this.stmts = {
      get: db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?'),
      set: db.prepare(
        `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
      ),
      del: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      sweep: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    };
    // Раз в час выметаем протухшее
    this.timer = setInterval(() => this.sweep(), 60 * 60 * 1000);
    this.timer.unref?.();
    this.sweep();
  }

  sweep() {
    try { this.stmts.sweep.run(Date.now()); } catch { /* не критично */ }
  }

  get(sid, cb) {
    try {
      const row = this.stmts.get.get(sid);
      if (!row) return cb(null, null);
      if (row.expires_at < Date.now()) {
        this.stmts.del.run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb) {
    try {
      const ttl = sess.cookie?.maxAge ?? 24 * 60 * 60 * 1000;
      this.stmts.set.run(sid, JSON.stringify(sess), Date.now() + ttl);
      cb(null);
    } catch (err) { cb(err); }
  }

  destroy(sid, cb) {
    try { this.stmts.del.run(sid); cb(null); } catch (err) { cb(err); }
  }

  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

// =====================================================================
//  Учётная запись
// =====================================================================

/**
 * Заводит администратора при первом запуске, если таблица пуста.
 * Логин и пароль берутся из .env; пароль в базе лежит только хешем.
 */
function ensureAdminUser() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM admin_users').get().n;
  if (count > 0) return null;

  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    throw new Error(
      'База пуста, а ADMIN_PASSWORD в .env не задан. ' +
      'Скопируйте .env.example в .env и укажите пароль администратора.'
    );
  }
  const hash = bcrypt.hashSync(password, 12);
  db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)')
    .run(username, hash);
  return username;
}

function findUser(username) {
  return db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
}

function verifyPassword(user, password) {
  return bcrypt.compareSync(password, user.password_hash);
}

function setPassword(userId, password) {
  const hash = bcrypt.hashSync(password, 12);
  db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hash, userId);
}

// =====================================================================
//  Защита эндпоинтов
// =====================================================================

/** Пропускает дальше только при живой сессии, иначе 401. */
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'unauthorized', message: 'Требуется вход в систему' });
}

module.exports = {
  SqliteStore, ensureAdminUser, findUser, verifyPassword, setPassword, requireAuth,
};
