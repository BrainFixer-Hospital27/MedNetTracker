'use strict';
const express = require('express');
const { db } = require('../db');
const { findUser, verifyPassword, setPassword, requireAuth } = require('../auth');

const router = express.Router();

// ---------------------------------------------------------------------
//  Защита от подбора: счётчик неудач на IP с нарастающей задержкой.
//  Живёт в памяти - для однопользовательской системы этого достаточно,
//  а перезапуск сервера в качестве сброса счётчика нам не страшен.
// ---------------------------------------------------------------------
const attempts = new Map(); // ip -> { count, until }
const MAX_ATTEMPTS = 8;
const LOCK_MS = 5 * 60 * 1000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Адрес посетителя.
 *
 * За Cloudflare подлинный адрес приходит в заголовке CF-Connecting-IP,
 * и он надёжнее X-Forwarded-For, который может содержать цепочку.
 * Заголовок читается только если он явно разрешён в настройках:
 * иначе его подделает кто угодно и обойдёт защиту от подбора.
 */
function clientIp(req) {
  const header = process.env.REAL_IP_HEADER;
  if (header) {
    const value = req.headers[header.toLowerCase()];
    if (value) return String(value).split(',')[0].trim();
  }
  return req.ip || 'unknown';
}

function registerFailure(ip) {
  const rec = attempts.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) rec.until = Date.now() + LOCK_MS;
  attempts.set(ip, rec);
  return rec;
}

function lockRemaining(ip) {
  const rec = attempts.get(ip);
  if (!rec || rec.until < Date.now()) return 0;
  return Math.ceil((rec.until - Date.now()) / 1000);
}

router.post('/login', async (req, res) => {
  const ip = clientIp(req);
  const locked = lockRemaining(ip);
  if (locked) {
    return res.status(429).json({
      error: 'too_many_attempts',
      message: `Слишком много попыток. Повторите через ${locked} с.`,
    });
  }

  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'bad_request', message: 'Введите логин и пароль' });
  }

  const user = findUser(String(username).trim());
  const ok = user && verifyPassword(user, String(password));

  if (!ok) {
    const rec = registerFailure(ip);
    // Задержка растёт с каждой неудачей: 0.4с, 0.8с, 1.2с ... до 4с
    await sleep(Math.min(400 * rec.count, 4000));
    return res.status(401).json({ error: 'invalid_credentials', message: 'Неверный логин или пароль' });
  }

  attempts.delete(ip);
  db.prepare(`UPDATE admin_users SET last_login_at = datetime('now') WHERE id = ?`).run(user.id);

  // Новый идентификатор сессии после входа - против фиксации сессии
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'session_error', message: 'Не удалось создать сессию' });
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.save(() => res.json({ user: { id: user.id, username: user.username } }));
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('mednet.sid');
    res.json({ ok: true });
  });
});

router.get('/me', (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({ user: { id: req.session.userId, username: req.session.username } });
  }
  res.status(401).json({ error: 'unauthorized' });
});

router.post('/password', requireAuth, (req, res) => {
  const { current_password: current, new_password: next } = req.body || {};
  const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.session.userId);
  if (!user || !verifyPassword(user, String(current || ''))) {
    return res.status(400).json({ error: 'bad_password', message: 'Текущий пароль неверен' });
  }
  if (!next || String(next).length < 8) {
    return res.status(400).json({ error: 'weak_password', message: 'Новый пароль короче 8 символов' });
  }
  setPassword(user.id, String(next));
  res.json({ ok: true });
});

module.exports = router;
