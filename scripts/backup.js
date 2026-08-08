'use strict';
/**
 * Резервная копия базы.
 *
 *   npm run backup                  -> data/backups/mednet-ГГГГ-ММ-ДД.sqlite
 *   npm run backup -- /путь/к/файлу
 *
 * Используется команда VACUUM INTO: она делает согласованный снимок
 * работающей базы, не останавливая сервер. Простое копирование файла
 * в режиме WAL так не умеет - часть данных может остаться в журнале.
 *
 * Планы этажей лежат отдельными файлами в data/svg, их копируйте
 * обычными средствами вместе с этим снимком.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR, DB_FILE } = require('../server/db');

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(DATA_DIR, 'backups', `mednet-${stamp}.sqlite`);

fs.mkdirSync(path.dirname(target), { recursive: true });
if (fs.existsSync(target)) {
  console.error(`\n  Файл ${target} уже существует. Укажите другое имя.\n`);
  process.exit(1);
}

// Экранирование апострофов: имя файла попадает в текст запроса
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

const source = fs.statSync(DB_FILE).size;
const copy = fs.statSync(target).size;
console.log('');
console.log(`  Снимок создан: ${target}`);
console.log(`  Исходная база ${Math.round(source / 1024)} КБ -> копия ${Math.round(copy / 1024)} КБ`);
console.log('');
console.log('  Не забудьте про планы этажей: они лежат в data/svg');
console.log('');
