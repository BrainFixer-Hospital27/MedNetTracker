'use strict';
const { db } = require('./db');

/** Оставляет из тела запроса только разрешённые поля; пустая строка -> NULL. */
function pick(body, fields) {
  const out = {};
  for (const f of fields) if (body[f] !== undefined) out[f] = body[f] === '' ? null : body[f];
  return out;
}

/** Собирает UPDATE ... SET из объекта. Возвращает false, если менять нечего. */
function update(table, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return false;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => data[k]), id);
  return true;
}

function insert(table, data) {
  const keys = Object.keys(data);
  const sql = `INSERT INTO ${table} (${keys.join(', ')})
               VALUES (${keys.map(() => '?').join(', ')})`;
  return db.prepare(sql).run(...keys.map((k) => data[k])).lastInsertRowid;
}

function notFound(res, what = 'Запись') {
  return res.status(404).json({ error: 'not_found', message: `${what} не найдена` });
}

function badRequest(res, message) {
  return res.status(400).json({ error: 'bad_request', message });
}

module.exports = { pick, update, insert, notFound, badRequest };
