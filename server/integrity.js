'use strict';
/**
 * Ревизия связей.
 *
 * Правила совместимости живут в справочнике `catalog.js` и применяются
 * при каждом изменении через API. Но данные могут попасть в базу и в
 * обход: перенос из старой системы, правка через sqlite3 руками,
 * версия приложения, где какого-то правила ещё не было.
 *
 * Здесь — независимая проверка того, что уже лежит в базе, и
 * возможность привести её в порядок.
 */
const { db } = require('./db');
const cat = require('./catalog');

const label = (type) => cat.DEVICE_TYPES[type]?.label || type;

/**
 * Ищет связи, нарушающие правила совместимости.
 * @returns {Array<{id, kind, reason, ...}>}
 */
function findInvalidLinks() {
  const problems = [];

  // --- Устройство подключено к устройству ---
  const pairs = db.prepare(`
    SELECT d.id, d.type, d.name, d.model, d.manufacturer, d.inventory_number,
           d.uplink_medium, d.room_id,
           p.id AS parent_id, p.type AS parent_type,
           p.name AS parent_name, p.model AS parent_model,
           r.room_number
    FROM devices d
    JOIN devices p ON p.id = d.uplink_device_id
    LEFT JOIN rooms r ON r.id = d.room_id
  `).all();

  for (const row of pairs) {
    // Пара может быть совместима несколькими средами сразу.
    // Ошибка - только если записанной среды нет среди допустимых.
    const options = cat.validMedia(row.type, row.parent_type);
    if (!options.length) {
      problems.push({
        kind: 'incompatible_device',
        id: row.id,
        title: describe(row),
        room_number: row.room_number,
        reason: `${label(row.type)} нельзя подключить к «${label(row.parent_type)}»`,
        parent_id: row.parent_id,
      });
    } else if (!options.includes(row.uplink_medium)) {
      // Связь допустима, но записанная среда для этой пары невозможна
      problems.push({
        kind: 'wrong_medium',
        id: row.id,
        title: describe(row),
        room_number: row.room_number,
        reason: `среда указана как «${row.uplink_medium || 'не задана'}», ` +
                `а возможна только ${options.map((m) => cat.MEDIA[m].label).join(' или ')}`,
        fix_medium: options[0],
      });
    }
  }

  // --- Устройство воткнуто в розетку ---
  const plugged = db.prepare(`
    SELECT d.id, d.type, d.name, d.model, d.manufacturer, d.inventory_number,
           s.label AS socket_label, r.room_number
    FROM devices d
    JOIN sockets s ON s.id = d.uplink_socket_id
    LEFT JOIN rooms r ON r.id = d.room_id
  `).all();

  for (const row of plugged) {
    if (!cat.canPlugIntoSocket(row.type)) {
      problems.push({
        kind: 'incompatible_socket',
        id: row.id,
        title: describe(row),
        room_number: row.room_number,
        reason: `${label(row.type)} не включается в сетевую розетку ` +
                `(указана розетка ${row.socket_label})`,
      });
    }
  }

  // --- Кольца в цепочке ---
  for (const seed of db.prepare('SELECT id FROM devices WHERE uplink_device_id IS NOT NULL').all()) {
    const seen = new Set();
    let current = seed.id;
    while (current) {
      if (seen.has(current)) {
        problems.push({
          kind: 'cycle',
          id: seed.id,
          title: 'цепочка замкнута в кольцо',
          reason: 'связи образуют замкнутый круг, цепочку невозможно проследить',
        });
        break;
      }
      seen.add(current);
      current = db.prepare('SELECT uplink_device_id FROM devices WHERE id = ?')
        .get(current)?.uplink_device_id;
    }
  }

  // --- Неизвестные типы ---
  for (const row of db.prepare('SELECT id, type, model, name, inventory_number FROM devices').all()) {
    if (!cat.DEVICE_TYPES[row.type]) {
      problems.push({
        kind: 'unknown_type',
        id: row.id,
        title: describe(row),
        reason: `тип «${row.type}» отсутствует в справочнике`,
      });
    }
  }

  return problems;
}

function describe(row) {
  return row.name
    || [row.manufacturer, row.model].filter(Boolean).join(' ')
    || row.inventory_number
    || label(row.type);
}

/**
 * Приводит базу в соответствие правилам.
 * Недопустимые связи разрываются: устройство остаётся в учёте, но
 * теряет восходящую связь. Данные не удаляются — только соединение,
 * которого физически не может существовать.
 */
function repairInvalidLinks() {
  const problems = findInvalidLinks();
  let detached = 0;
  let mediumFixed = 0;

  const clear = db.prepare(
    'UPDATE devices SET uplink_device_id = NULL, uplink_socket_id = NULL, uplink_medium = NULL WHERE id = ?'
  );
  const setMedium = db.prepare('UPDATE devices SET uplink_medium = ? WHERE id = ?');

  db.transaction(() => {
    for (const problem of problems) {
      if (problem.kind === 'wrong_medium') {
        setMedium.run(problem.fix_medium, problem.id);
        mediumFixed += 1;
      } else if (problem.kind !== 'unknown_type') {
        clear.run(problem.id);
        detached += 1;
      }
    }
  })();

  return { detached, mediumFixed, problems };
}

module.exports = { findInvalidLinks, repairInvalidLinks };
