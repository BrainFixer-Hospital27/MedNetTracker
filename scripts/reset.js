'use strict';
/**
 * Полный сброс базы.
 *
 *   npm run reset            - спросит подтверждение
 *   npm run reset -- --yes   - без вопросов
 *
 * Удаляет файл базы вместе с журналами WAL и загруженные планы этажей.
 * Учётная запись администратора будет создана заново из .env
 * при следующем запуске сервера.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { DB_FILE, SVG_DIR } = require('../server/db');

const auto = process.argv.includes('--yes') || process.argv.includes('-y');

function wipe() {
  let removed = 0;

  for (const suffix of ['', '-wal', '-shm']) {
    const file = DB_FILE + suffix;
    if (fs.existsSync(file)) { fs.unlinkSync(file); removed += 1; }
  }

  let plans = 0;
  if (fs.existsSync(SVG_DIR)) {
    for (const name of fs.readdirSync(SVG_DIR)) {
      // Файл-образец не трогаем: он не относится к данным
      if (name.startsWith('_')) continue;
      fs.unlinkSync(path.join(SVG_DIR, name));
      plans += 1;
    }
  }

  console.log('');
  console.log(`  Удалено файлов базы: ${removed}`);
  console.log(`  Удалено планов этажей: ${plans}`);
  console.log('');
  console.log('  База будет создана заново при следующем запуске:');
  console.log('    npm start          — чистая база');
  console.log('    npm run seed       — с демонстрационными данными');
  console.log('');
}

if (auto) {
  wipe();
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log('');
console.log('  Будет безвозвратно удалено всё содержимое базы:');
console.log(`    ${DB_FILE}`);
console.log(`    планы этажей в ${SVG_DIR}`);
console.log('');
rl.question('  Продолжить? Введите «да» для подтверждения: ', (answer) => {
  rl.close();
  if (['да', 'yes', 'y'].includes(answer.trim().toLowerCase())) wipe();
  else console.log('\n  Отменено. Ничего не изменилось.\n');
});
