'use strict';
const path = require('path');
const fs = require('fs');
const { Database } = require('./sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SVG_DIR = path.join(DATA_DIR, 'svg');
const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(DATA_DIR, 'database.sqlite');

try {
  fs.mkdirSync(SVG_DIR, { recursive: true });
  // Проверяем именно запись: в контейнере каталог данных нередко
  // оказывается смонтирован от root, а процесс работает от node,
  // и отказ выглядел бы как невнятная ошибка где-то в глубине.
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch (err) {
  throw new Error(
    `Каталог данных ${DATA_DIR} недоступен для записи (${err.code || err.message}).\n` +
    'При запуске в Docker выполните на хосте:\n' +
    '    mkdir -p data/svg && sudo chown -R 1000:1000 data'
  );
}

const db = new Database(DB_FILE);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// Встроенные LOWER/UPPER в SQLite работают только с латиницей: LOWER('ОС-41001')
// вернёт строку без изменений, и поиск по русскому тексту промахнётся.
// Регистрируем собственную функцию поверх JavaScript, который знает Юникод.
db.function('lc', { deterministic: true }, (value) =>
  value === null || value === undefined ? null : String(value).toLowerCase());

/**
 * Добавляет столбец, если его ещё нет.
 *
 * CREATE TABLE IF NOT EXISTS не трогает уже существующую таблицу,
 * поэтому новые поля в развёрнутой базе сами не появятся. Здесь -
 * минимальный механизм для таких случаев: сверяемся с PRAGMA и
 * дописываем недостающее. Данные при этом не страдают.
 */
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`  Добавлен столбец ${table}.${column}`);
  return true;
}

/** Разворачивает схему. Идемпотентно: все CREATE идут с IF NOT EXISTS. */
function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Поля, появившиеся после первого выпуска
  ensureColumn('devices', 'poe_budget', 'INTEGER');
}

/** Запись в журнал изменений. Никогда не роняет основной запрос. */
function logChange(req, entity, entityId, action, summary) {
  try {
    db.prepare(
      `INSERT INTO change_log (username, entity, entity_id, action, summary)
       VALUES (?, ?, ?, ?, ?)`
    ).run(req?.session?.username || null, entity, entityId ?? null, action, summary || null);
  } catch (err) {
    console.error('[change_log]', err.message);
  }
}

module.exports = { db, migrate, ensureColumn, logChange, DATA_DIR, SVG_DIR, DB_FILE };
