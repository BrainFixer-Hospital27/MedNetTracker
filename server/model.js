'use strict';
const { db } = require('./db');
const cat = require('./catalog');

// =====================================================================
//  Преобразование строки БД в объект API
// =====================================================================

/**
 * Склеивает две колонки восходящей связи обратно в один объект.
 * kind: 'none' | 'socket' | 'device'
 */
function uplinkOf(row) {
  if (row.uplink_socket_id) {
    return { kind: 'socket', id: row.uplink_socket_id, medium: row.uplink_medium || 'ethernet' };
  }
  if (row.uplink_device_id) {
    return { kind: 'device', id: row.uplink_device_id, medium: row.uplink_medium || 'ethernet' };
  }
  return { kind: 'none', id: null, medium: null };
}

/**
 * Строка devices -> объект для клиента.
 * @param {object} row
 * @param {boolean} withSecrets отдавать ли пароли роутеров (только в карточке)
 */
function serializeDevice(row, withSecrets = false) {
  if (!row) return null;
  const out = { ...row };
  delete out.uplink_socket_id;
  delete out.uplink_device_id;
  delete out.uplink_medium;
  out.uplink = uplinkOf(row);

  const meta = cat.DEVICE_TYPES[row.type];
  out.type_label = meta ? meta.label : row.type;
  out.layer = meta ? meta.layer : 'other';
  out.icon = meta ? meta.icon : 'other';

  if (!withSecrets) for (const f of cat.SECRET_FIELDS) delete out[f];
  return out;
}

const DEVICE_SELECT = `SELECT * FROM devices`;

function getDevice(id, withSecrets = false) {
  const row = db.prepare(`${DEVICE_SELECT} WHERE id = ?`).get(id);
  return serializeDevice(row, withSecrets);
}

// =====================================================================
//  Сквозная цепочка прослеживаемости
//  Устройство -> ... -> розетка -> порт Cisco -> коммутатор
//  и вверх по географии: помещение -> отделение / этаж -> корпус.
//  Разрыв в любом месте не считается ошибкой: цепочка просто короче.
// =====================================================================

/** Географическая часть пути для помещения. */
function placeChain(roomId) {
  if (!roomId) return null;
  return db.prepare(`
    SELECT r.id   AS room_id,   r.room_number, r.name AS room_name,
           f.id   AS floor_id,  f.floor_number,
           b.id   AS building_id, b.name AS building_name,
           d.id   AS department_id, d.name AS department_name, d.color AS department_color
    FROM rooms r
    JOIN floors f    ON f.id = r.floor_id
    JOIN buildings b ON b.id = f.building_id
    LEFT JOIN departments d ON d.id = r.department_id
    WHERE r.id = ?
  `).get(roomId) || null;
}

/** Розетка вместе с портом Cisco и коммутатором, если они привязаны. */
function socketChain(socketId) {
  if (!socketId) return null;
  return db.prepare(`
    SELECT s.id, s.label, s.room_id, s.pos_x, s.pos_y,
           p.id AS port_id, p.port_number, p.status AS port_status, p.vlan,
           sw.id AS switch_id, sw.name AS switch_name, sw.model AS switch_model
    FROM sockets s
    LEFT JOIN cisco_ports p     ON p.id = s.cisco_port_id
    LEFT JOIN cisco_switches sw ON sw.id = p.switch_id
    WHERE s.id = ?
  `).get(socketId) || null;
}

/**
 * Полная цепочка от устройства вверх до коммутатора Cisco.
 * Возвращает массив звеньев от самого устройства к магистрали.
 * Защищён от циклов: длина ограничена, посещённые id запоминаются.
 */
function buildChain(deviceId) {
  const links = [];
  const seen = new Set();
  let row = db.prepare(`${DEVICE_SELECT} WHERE id = ?`).get(deviceId);

  while (row && !seen.has(row.id) && links.length < 32) {
    seen.add(row.id);
    const meta = cat.DEVICE_TYPES[row.type];
    links.push({
      kind: 'device',
      id: row.id,
      type: row.type,
      label: deviceTitle(row),
      type_label: meta ? meta.label : row.type,
      medium: row.uplink_medium,
    });

    if (row.uplink_device_id) {
      row = db.prepare(`${DEVICE_SELECT} WHERE id = ?`).get(row.uplink_device_id);
      continue;
    }
    if (row.uplink_socket_id) {
      const sock = socketChain(row.uplink_socket_id);
      if (sock) {
        links.push({
          kind: 'socket', id: sock.id, label: sock.label,
          type_label: 'Розетка', medium: 'ethernet',
        });
        if (sock.port_id) {
          links.push({
            kind: 'cisco_port', id: sock.port_id,
            label: `${sock.switch_name} / порт ${sock.port_number}`,
            type_label: 'Порт коммутатора', status: sock.port_status, vlan: sock.vlan,
          });
        }
      }
    }
    break;
  }
  return links;
}

/** Что подключено к данному устройству (одним уровнем вниз). */
function childrenOf(deviceId) {
  return db.prepare(`${DEVICE_SELECT} WHERE uplink_device_id = ? ORDER BY type, id`)
    .all(deviceId).map((r) => serializeDevice(r));
}

/** Понятное имя устройства для списков и подсказок. */
function deviceTitle(row) {
  if (row.name) return row.name;
  const parts = [row.manufacturer, row.model].filter(Boolean).join(' ');
  if (parts) return parts;
  const meta = cat.DEVICE_TYPES[row.type];
  return meta ? meta.label : row.type;
}

// =====================================================================
//  Проверки при изменении связей
// =====================================================================

/**
 * Не создаст ли подключение childId -> parentId петлю.
 * Идём от предполагаемого родителя вверх: если встретили ребёнка - цикл.
 */
function wouldCreateCycle(childId, parentId) {
  let cur = parentId;
  const guard = new Set();
  while (cur) {
    if (cur === childId) return true;
    if (guard.has(cur)) return true;
    guard.add(cur);
    const row = db.prepare('SELECT uplink_device_id FROM devices WHERE id = ?').get(cur);
    cur = row ? row.uplink_device_id : null;
  }
  return false;
}

/**
 * Проверяет, свободны ли порты у родителя-концентратора.
 * Возвращает { used, total } либо null, если у типа портов нет.
 */
function portUsage(parentId) {
  const parent = db.prepare('SELECT type, ports_count FROM devices WHERE id = ?').get(parentId);
  if (!parent) return null;
  const meta = cat.DEVICE_TYPES[parent.type];
  if (!meta || !meta.fields || !meta.fields.includes('ports_count')) return null;
  const used = db.prepare(
    `SELECT COUNT(*) AS n FROM devices WHERE uplink_device_id = ? AND uplink_medium = 'ethernet'`
  ).get(parentId).n;
  return { used, total: parent.ports_count || null };
}

/**
 * Проверка смены типа устройства.
 *
 * Правила совместимости привязаны к типу, поэтому переназначение типа
 * способно задним числом сделать уже существующие связи недопустимыми:
 * был USB-принтер на компьютере, стал компьютером на компьютере.
 * Проверяем обе стороны - и собственное подключение устройства,
 * и всё, что подключено к нему самому.
 *
 * @returns {string[]} список препятствий; пустой массив - можно менять
 */
function validateTypeChange(deviceId, newType) {
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!row) return ['Устройство не найдено'];
  if (row.type === newType) return [];

  const meta = cat.DEVICE_TYPES[newType];
  if (!meta) return ['Неизвестный тип оборудования'];

  const problems = [];

  // Собственная восходящая связь
  if (row.uplink_socket_id && !cat.canPlugIntoSocket(newType)) {
    const sock = db.prepare('SELECT label FROM sockets WHERE id = ?').get(row.uplink_socket_id);
    problems.push(
      `${meta.label} не включается в сетевую розетку, а устройство сейчас ` +
      `подключено к розетке ${sock ? sock.label : ''}`.trim()
    );
  }
  if (row.uplink_device_id) {
    const parent = db.prepare('SELECT type FROM devices WHERE id = ?').get(row.uplink_device_id);
    if (parent && !cat.validMedia(newType, parent.type).length) {
      problems.push(
        `${meta.label} нельзя подключить к «${cat.DEVICE_TYPES[parent.type]?.label || parent.type}», ` +
        'а устройство сейчас подключено именно туда'
      );
    }
  }

  // Всё, что висит на этом устройстве
  const children = db.prepare('SELECT id, type FROM devices WHERE uplink_device_id = ?')
    .all(deviceId);
  const orphaned = children.filter((c) => !cat.validMedia(c.type, newType).length);
  if (orphaned.length) {
    const names = [...new Set(orphaned.map((c) => cat.DEVICE_TYPES[c.type]?.label || c.type))];
    problems.push(
      `к устройству подключено оборудование, несовместимое с типом «${meta.label}»: ` +
      `${names.join(', ')} (всего ${orphaned.length})`
    );
  }

  return problems;
}

/**
 * Полная проверка предполагаемого подключения.
 * Возвращает { ok: true, medium } или { ok: false, message }.
 */
function validateConnection(childId, target, options = {}) {
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(childId);
  if (!row) return { ok: false, message: 'Устройство не найдено' };
  // asType позволяет проверить связь по типу, который устройство только
  // получит: смена типа и подключение могут прийти одним запросом.
  const child = options.asType ? { ...row, type: options.asType } : row;
  if (!cat.DEVICE_TYPES[child.type]) {
    return { ok: false, message: 'Неизвестный тип оборудования' };
  }

  if (target.kind === 'none') return { ok: true, medium: null };

  if (target.kind === 'socket') {
    const sock = db.prepare('SELECT * FROM sockets WHERE id = ?').get(target.id);
    if (!sock) return { ok: false, message: 'Розетка не найдена' };
    if (!cat.canPlugIntoSocket(child.type)) {
      const meta = cat.DEVICE_TYPES[child.type];
      return { ok: false, message: `${meta ? meta.label : child.type} не подключается в сетевую розетку` };
    }
    const busy = db.prepare(
      'SELECT id, name, type FROM devices WHERE uplink_socket_id = ? AND id <> ?'
    ).all(sock.id, childId);
    // Розетка на одно устройство: предупреждаем, но не запрещаем -
    // решение принимает администратор в модальном окне.
    return { ok: true, medium: 'ethernet', warning: busy.length
      ? `В розетку ${sock.label} уже включено устройств: ${busy.length}`
      : null };
  }

  if (target.kind === 'device') {
    if (Number(target.id) === Number(childId)) {
      return { ok: false, message: 'Устройство нельзя подключить само к себе' };
    }
    const parent = db.prepare('SELECT * FROM devices WHERE id = ?').get(target.id);
    if (!parent) return { ok: false, message: 'Целевое устройство не найдено' };

    const options = cat.validMedia(child.type, parent.type);
    if (!options.length) {
      return { ok: false, message: cat.explainRejection(child.type, parent.type) };
    }

    // Если среду указали явно, она должна быть среди допустимых
    const requested = target.medium;
    if (requested && !options.includes(requested)) {
      return {
        ok: false,
        message: `Соединение «${cat.MEDIA[requested]?.label || requested}» для этой пары ` +
          `невозможно. Доступно: ${options.map((m) => cat.MEDIA[m].label).join(', ')}`,
      };
    }
    const medium = requested || options[0];

    if (wouldCreateCycle(childId, parent.id)) {
      return { ok: false, message: 'Такое подключение замкнёт цепочку в кольцо' };
    }

    let warning = null;
    if (medium === 'ethernet') {
      const usage = portUsage(parent.id);
      if (usage && usage.total && usage.used >= usage.total) {
        warning = `Свободных портов нет: занято ${usage.used} из ${usage.total}`;
      }
    }
    return { ok: true, medium, options, warning };
  }

  return { ok: false, message: 'Неизвестный тип подключения' };
}

/**
 * Где физически находится точка подключения устройства.
 * Нужно, чтобы понять, не потеряла ли связь смысл после переезда.
 */
function uplinkTargetPlace(row) {
  if (row.uplink_socket_id) {
    const sock = db.prepare(`
      SELECT s.label, s.room_id, r.floor_id
      FROM sockets s JOIN rooms r ON r.id = s.room_id WHERE s.id = ?
    `).get(row.uplink_socket_id);
    return sock ? { kind: 'socket', ...sock } : null;
  }
  if (row.uplink_device_id) {
    const parent = db.prepare(`
      SELECT d.room_id, d.type, d.name, d.model, d.manufacturer, r.floor_id
      FROM devices d LEFT JOIN rooms r ON r.id = d.room_id WHERE d.id = ?
    `).get(row.uplink_device_id);
    return parent ? { kind: 'device', ...parent, label: deviceTitle(parent) } : null;
  }
  return null;
}

/** Раскладывает объект uplink обратно по колонкам таблицы. */
function uplinkColumns(target, medium) {
  if (!target || target.kind === 'none') {
    return { uplink_socket_id: null, uplink_device_id: null, uplink_medium: null };
  }
  if (target.kind === 'socket') {
    return { uplink_socket_id: target.id, uplink_device_id: null, uplink_medium: medium || 'ethernet' };
  }
  return { uplink_socket_id: null, uplink_device_id: target.id, uplink_medium: medium || 'ethernet' };
}

/**
 * Держит статус порта Cisco в согласии с реальностью: если к розетке
 * что-то подключено - порт занят, если нет - свободен. Повреждённые
 * и зарезервированные порты не трогаем, это решение администратора.
 */
function syncPortStatus(target) {
  if (!target || target.kind !== 'socket' || !target.id) return;
  const sock = db.prepare('SELECT cisco_port_id FROM sockets WHERE id = ?').get(target.id);
  if (!sock || !sock.cisco_port_id) return;
  const port = db.prepare('SELECT status FROM cisco_ports WHERE id = ?').get(sock.cisco_port_id);
  if (!port || port.status === 'damaged' || port.status === 'reserved') return;
  const used = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE uplink_socket_id = ?')
    .get(target.id).n;
  db.prepare('UPDATE cisco_ports SET status = ? WHERE id = ?')
    .run(used > 0 ? 'active' : 'free', sock.cisco_port_id);
}

module.exports = {
  serializeDevice, getDevice, DEVICE_SELECT, deviceTitle,
  placeChain, socketChain, buildChain, childrenOf,
  validateConnection, validateTypeChange, uplinkColumns, uplinkTargetPlace, wouldCreateCycle, portUsage, syncPortStatus,
};
