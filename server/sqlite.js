'use strict';
/**
 * Тонкая обёртка над встроенным в Node модулем `node:sqlite`.
 *
 * Зачем она нужна. Изначально проект использовал пакет better-sqlite3,
 * но это нативный модуль на C++: там, где нет Visual Studio Build Tools,
 * `npm install` падает на сборке. Встроенный `node:sqlite` появился в
 * Node 22.5 и делает то же самое, не требуя компилятора вообще.
 *
 * Интерфейсы у них похожи, но не совпадают. Обёртка закрывает четыре
 * расхождения, чтобы остальной код приложения не пришлось переписывать:
 *
 *   1. нет метода `pragma()`;
 *   2. нет метода `transaction()`;
 *   3. параметры `undefined` и `true`/`false` вызывают ошибку привязки;
 *   4. у ошибок другой формат — нет привычного кода `SQLITE_CONSTRAINT_*`.
 */

// Node 22 предупреждает, что модуль экспериментальный. Предупреждение
// выводится один раз при загрузке и в журнале сервера только мешает,
// поэтому глушим именно его, не трогая остальные.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (/SQLite is an experimental feature/i.test(text)) return;
  return emitWarning.call(process, warning, ...rest);
};

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  throw new Error(
    `Встроенный модуль node:sqlite недоступен (у вас Node ${process.versions.node}). ` +
    'Нужен Node.js 22.5 или новее — скачать можно на nodejs.org. ' +
    (major < 22 || (major === 22 && minor < 5)
      ? 'Ваша версия слишком старая.'
      : `Исходная ошибка: ${err.message}`)
  );
}

// ---------------------------------------------------------------------
//  Приведение параметров
// ---------------------------------------------------------------------

/**
 * SQLite принимает только числа, строки, null, BigInt и буферы.
 * JavaScript же охотно подсовывает undefined (например, из необязательного
 * поля запроса) и логические значения. Приводим их к тому, что SQLite
 * поймёт, вместо того чтобы падать с невнятным «cannot be bound».
 */
function bindable(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ');
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

function bindableAll(args) {
  // Именованные параметры передаются одним объектом - его тоже чистим
  if (args.length === 1 && args[0] && typeof args[0] === 'object'
      && !Array.isArray(args[0]) && !(args[0] instanceof Date)
      && !Buffer.isBuffer(args[0])) {
    const out = {};
    for (const [key, value] of Object.entries(args[0])) out[key] = bindable(value);
    return [out];
  }
  return args.map(bindable);
}

// ---------------------------------------------------------------------
//  Ошибки
// ---------------------------------------------------------------------

/**
 * Помечает ошибки нарушения целостности так, как их ожидает
 * остальной код: по наличию подстроки SQLITE_CONSTRAINT.
 * Числовые коды SQLite: 19 - общий CONSTRAINT, 1555/2067 - UNIQUE,
 * 787 - FOREIGN KEY, 275 - CHECK, 1299 - NOT NULL.
 */
function decorateError(err) {
  if (!err || typeof err !== 'object') return err;
  const isConstraint =
    (typeof err.errcode === 'number' && (err.errcode & 0xff) === 19) ||
    /constraint failed/i.test(err.message || '');
  if (isConstraint && !/SQLITE_CONSTRAINT/.test(err.code || '')) {
    err.sqliteCode = err.code;
    err.code = 'SQLITE_CONSTRAINT';
  }
  return err;
}

function rethrow(fn) {
  try {
    return fn();
  } catch (err) {
    throw decorateError(err);
  }
}

// ---------------------------------------------------------------------
//  Подготовленный запрос
// ---------------------------------------------------------------------

class Statement {
  constructor(native) {
    this.native = native;
  }

  run(...args) {
    return rethrow(() => {
      const result = this.native.run(...bindableAll(args));
      return {
        changes: Number(result.changes),
        // Для очень больших таблиц SQLite вернёт BigInt - приводим к числу,
        // иначе значение просочится в JSON и сломает клиент.
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    });
  }

  get(...args) {
    return rethrow(() => {
      const row = this.native.get(...bindableAll(args));
      return row === undefined ? undefined : toPlain(row);
    });
  }

  all(...args) {
    return rethrow(() => this.native.all(...bindableAll(args)).map(toPlain));
  }
}

/**
 * node:sqlite отдаёт строки объектами без прототипа. Работать с такими
 * можно, но неудобно: у них нет ни hasOwnProperty, ни toString, а в
 * отладочном выводе они помечаются как [Object: null prototype].
 * Возвращаем обычные объекты.
 */
function toPlain(row) {
  return Object.assign({}, row);
}

// ---------------------------------------------------------------------
//  Соединение
// ---------------------------------------------------------------------

class Database {
  constructor(path) {
    this.native = new DatabaseSync(path);
    // Один и тот же запрос готовится один раз: разбор SQL стоит дороже
    // самого выполнения, а набор запросов у приложения конечный.
    this.cache = new Map();
    this.depth = 0;
  }

  prepare(sql) {
    let statement = this.cache.get(sql);
    if (!statement) {
      statement = new Statement(rethrow(() => this.native.prepare(sql)));
      this.cache.set(sql, statement);
    }
    return statement;
  }

  exec(sql) {
    return rethrow(() => this.native.exec(sql));
  }

  /** Замена better-sqlite3: db.pragma('foreign_keys = ON'). */
  pragma(text) {
    return rethrow(() => {
      const statement = this.native.prepare(`PRAGMA ${text}`);
      // Читающие PRAGMA возвращают строку, устанавливающие - ничего
      try { return statement.all().map(toPlain); } catch { return statement.run(); }
    });
  }

  /** Регистрация функции SQL. Сигнатура совпадает с better-sqlite3. */
  function(name, options, fn) {
    if (typeof options === 'function') { fn = options; options = {}; }
    return this.native.function(name, options || {}, fn);
  }

  /**
   * Замена db.transaction(fn) из better-sqlite3: возвращает функцию,
   * которая выполняет тело в транзакции. Вложенные вызовы используют
   * точки сохранения, поэтому внутренний откат не рушит внешнюю
   * транзакцию целиком.
   */
  transaction(fn) {
    const db = this;
    return function (...args) {
      const nested = db.depth > 0;
      const savepoint = `sp_${db.depth}`;
      db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
      db.depth += 1;
      try {
        const result = fn.apply(this, args);
        db.depth -= 1;
        db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
        return result;
      } catch (err) {
        db.depth -= 1;
        try {
          db.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
          if (nested) db.exec(`RELEASE ${savepoint}`);
        } catch { /* соединение уже в нерабочем состоянии - пробрасываем исходную ошибку */ }
        throw decorateError(err);
      }
    };
  }

  close() {
    this.cache.clear();
    return this.native.close();
  }
}

module.exports = { Database, decorateError };
