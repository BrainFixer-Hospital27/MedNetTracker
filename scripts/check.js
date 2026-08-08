'use strict';
/**
 * Ревизия базы: ищет связи, нарушающие правила совместимости.
 *
 *   npm run check          - только отчёт
 *   npm run check -- --fix - разорвать недопустимые связи
 */
require('dotenv').config({ quiet: true });
const { migrate } = require('../server/db');
const { findInvalidLinks, repairInvalidLinks } = require('../server/integrity');

migrate();
const fix = process.argv.includes('--fix');
const problems = findInvalidLinks();

console.log('');
if (!problems.length) {
  console.log('  Нарушений не найдено: все связи соответствуют правилам.');
  console.log('');
  process.exit(0);
}

console.log(`  Найдено нарушений: ${problems.length}`);
console.log('');
const byKind = {};
for (const p of problems) (byKind[p.kind] ||= []).push(p);
const KIND_LABELS = {
  incompatible_device: 'Недопустимая пара «устройство — устройство»',
  incompatible_socket: 'Устройство не может быть в розетке',
  wrong_medium: 'Неверно указана среда передачи',
  cycle: 'Замкнутая цепочка',
  unknown_type: 'Неизвестный тип оборудования',
};
for (const [kind, list] of Object.entries(byKind)) {
  console.log(`  ${KIND_LABELS[kind] || kind} — ${list.length}`);
  for (const p of list.slice(0, 10)) {
    const place = p.room_number ? ` [каб. ${p.room_number}]` : '';
    console.log(`     #${p.id} ${p.title}${place}`);
    console.log(`        ${p.reason}`);
  }
  if (list.length > 10) console.log(`     … и ещё ${list.length - 10}`);
  console.log('');
}

if (!fix) {
  console.log('  Чтобы разорвать недопустимые связи: npm run check -- --fix');
  console.log('  Само оборудование при этом сохранится, пропадёт только подключение.');
  console.log('');
  process.exit(1);
}

const result = repairInvalidLinks();
console.log(`  Разорвано связей: ${result.detached}`);
console.log(`  Исправлено сред передачи: ${result.mediumFixed}`);
console.log('');
