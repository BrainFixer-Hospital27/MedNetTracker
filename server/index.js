'use strict';
require('dotenv').config({ quiet: true });

const path = require('path');
const express = require('express');
const session = require('express-session');

const { migrate, DB_FILE } = require('./db');
const { SqliteStore, ensureAdminUser, requireAuth } = require('./auth');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ---------------------------------------------------------------------
//  Подготовка базы
// ---------------------------------------------------------------------
migrate();
const created = ensureAdminUser();

const app = express();
app.disable('x-powered-by');

// Доверие к обратному прокси.
//
// Без него счётчик неудачных попыток входа увидит один и тот же адрес
// для всех посетителей - и первый же перебор заблокирует вход всем.
// Значение задаёт, скольким прокси доверять: 1 - только nginx,
// 2 - связка Cloudflare и nginx. Можно указать и список подсетей.
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxy !== false) app.set('trust proxy', trustProxy);

function parseTrustProxy(value) {
  if (!value || value === '0' || value === 'false') return false;
  if (value === 'true') return 1;
  if (/^\d+$/.test(value)) return Number(value);
  // Список адресов или подсетей через запятую
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

// Планы этажей с вшитой растровой подложкой бывают увесистыми
app.use(express.json({ limit: process.env.BODY_LIMIT || '32mb' }));
app.use(express.urlencoded({ extended: false }));

app.use(session({
  name: 'mednet.sid',
  store: new SqliteStore(),
  secret: process.env.SESSION_SECRET || 'mednet-insecure-default-change-me',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    // В больничной сети обычно обычный http, поэтому secure по умолчанию
    // выключен: с secure=true куку по http браузер просто не сохранит.
    secure: process.env.COOKIE_SECURE === '1',
    maxAge: Number(process.env.SESSION_HOURS || 12) * 60 * 60 * 1000,
  },
}));

// ---------------------------------------------------------------------
//  Маршруты
// ---------------------------------------------------------------------
// Проверка живости для Docker и обратного прокси. Намеренно без
// авторизации и без каких-либо сведений о состоянии базы: этот адрес
// видит инфраструктура, а не человек.
const startedAt = Date.now();
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', uptime: Math.round((Date.now() - startedAt) / 1000) });
});

app.use('/api/auth', require('./routes/auth'));

// Всё остальное закрыто сессией
app.use('/api', requireAuth);
app.use('/api', require('./routes/map'));
app.use('/api', require('./routes/structure'));
app.use('/api', require('./routes/network'));
app.use('/api', require('./routes/reports'));
app.use('/api/devices', require('./routes/devices'));

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Такого эндпоинта нет' });
});

// ---------------------------------------------------------------------
//  Статика и переход на SPA
// ---------------------------------------------------------------------
// Сборщика нет, значит нет и хешей в именах файлов: app.css после
// обновления называется так же, как вчера. Поэтому долгий срок жизни
// кеша означал бы, что новая версия доедет до браузера через час, а
// не сразу. Ставим no-cache: файл кешируется, но перед каждым
// использованием браузер спрашивает сервер, не изменился ли он.
// Отвечает сервер по ETag коротким «304 Not Modified», трафика почти нет.
app.use(express.static(PUBLIC_DIR, {
  index: false,
  etag: true,
  lastModified: true,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Любой прочий адрес отдаёт оболочку: маршрутизацию дальше ведёт Vue Router
app.use((req, res) => {
  if (req.method !== 'GET') return res.status(405).end();
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------------------------------------------------------------------
//  Обработчик ошибок. Наружу отдаём только понятный текст,
//  подробности с трассировкой пишем в консоль сервера.
// ---------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, '\n', err);
  if (res.headersSent) return next(err);
  // Адаптер node:sqlite проставляет код SQLITE_CONSTRAINT; на всякий
  // случай проверяем и текст - формулировки у разных версий отличаются.
  const isConstraint = /SQLITE_CONSTRAINT/.test(String(err.code || '')) ||
    /constraint failed/i.test(String(err.message || ''));
  res.status(isConstraint ? 409 : 500).json({
    error: isConstraint ? 'constraint' : 'server_error',
    message: isConstraint
      ? 'Операция нарушает целостность данных'
      : 'Внутренняя ошибка сервера. Подробности в журнале.',
  });
});

// ---------------------------------------------------------------------
// Месячный срез показателей. Снимается один раз в месяц при первом
// запуске: динамику задним числом собрать невозможно, поэтому копить
// её надо с самого начала.
try {
  const result = require('./snapshots').capture();
  if (result.created) console.log(`  Снят срез показателей за ${result.period}`);
} catch (err) {
  console.error('[snapshots]', err.message);
}

// Ревизия при старте: если в базе есть связи, нарушающие правила
// совместимости (например, после переноса данных), администратор
// узнает об этом сразу, а не наткнётся случайно через полгода.
try {
  const { findInvalidLinks } = require('./integrity');
  const problems = findInvalidLinks();
  if (problems.length) {
    console.warn('');
    console.warn(`  ВНИМАНИЕ: в базе ${problems.length} связей нарушают правила совместимости.`);
    console.warn('  Подробности: npm run check');
  }
} catch (err) {
  console.error('[integrity]', err.message);
}

app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  MedNet Tracker');
  console.log(`  Адрес   http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  База    ${DB_FILE}`);
  if (created) console.log(`  Создана учётная запись администратора: ${created}`);
  console.log('');
});
