'use strict';
/**
 * Отчёты.
 *
 * Замысел двухслойный. Реестры - плоские таблицы «по строке на объект»,
 * из которых сводными таблицами Excel можно получить любой разрез, в том
 * числе тот, который никто не предвидел. Сводки - готовые ответы на
 * вопросы, которые задают регулярно, чтобы не собирать их вручную каждый
 * раз.
 *
 * Каждый отчёт описывается одинаково: ключ, название, построитель.
 * Из этого списка автоматически собираются и книга XLSX, и отдельные
 * выгрузки CSV, и печатная сводка, и перечень кнопок в интерфейсе.
 */
const { db } = require('./db');
const cat = require('./catalog');
const { Workbook } = require('./xlsx');

const label = (type) => cat.DEVICE_TYPES[type]?.label || type;
const statusLabel = (key) => cat.DEVICE_STATUSES[key]?.label || key;
const mediumLabel = (key) => (key ? cat.MEDIA[key]?.label || key : '');

// =====================================================================
//  Охват выгрузки
// =====================================================================

/**
 * Собирает условие WHERE по выбранному охвату.
 * @param {object} scope { building_id, floor_id, department_id }
 * @param {object} aliases имена таблиц в запросе
 */
function scopeClause(scope, aliases = {}) {
  const room = aliases.room || 'r';
  const floor = aliases.floor || 'f';
  const where = [];
  const args = [];
  if (scope.building_id)   { where.push(`${floor}.building_id = ?`);   args.push(Number(scope.building_id)); }
  if (scope.floor_id)      { where.push(`${room}.floor_id = ?`);       args.push(Number(scope.floor_id)); }
  if (scope.department_id) { where.push(`${room}.department_id = ?`);  args.push(Number(scope.department_id)); }
  return { where, args };
}

/** Человекочитаемое описание охвата - идёт подписью над каждой таблицей. */
function describeScope(scope) {
  const parts = [];
  if (scope.building_id) {
    const b = db.prepare('SELECT name FROM buildings WHERE id = ?').get(scope.building_id);
    if (b) parts.push(b.name);
  }
  if (scope.floor_id) {
    const f = db.prepare('SELECT floor_number FROM floors WHERE id = ?').get(scope.floor_id);
    if (f) parts.push(`${f.floor_number} этаж`);
  }
  if (scope.department_id) {
    const d = db.prepare('SELECT name FROM departments WHERE id = ?').get(scope.department_id);
    if (d) parts.push(d.name);
  }
  const place = parts.length ? parts.join(' · ') : 'вся организация';
  const now = new Date();
  const stamp = `${String(now.getDate()).padStart(2, '0')}.` +
    `${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`;
  return `${place} — по состоянию на ${stamp}`;
}

// =====================================================================
//  Цепочки: общий расчёт, нужен нескольким отчётам
// =====================================================================

/**
 * Строит карту связей один раз и переиспользует.
 * Обход в цикле по каждому устройству отдельно на нескольких сотнях
 * записей давал бы тысячи запросов; здесь всё считается за два.
 */
function buildTopology() {
  const devices = db.prepare(`
    SELECT d.id, d.type, d.name, d.model, d.manufacturer, d.inventory_number,
           d.mac_address, d.ip_address, d.status, d.responsible_person,
           d.uplink_socket_id, d.uplink_device_id, d.uplink_medium,
           d.room_id, r.room_number, r.name AS room_name, r.floor_id, r.department_id,
           f.floor_number, f.building_id, b.name AS building_name, b.short_name AS building_short,
           dep.name AS department_name
    FROM devices d
    LEFT JOIN rooms r        ON r.id = d.room_id
    LEFT JOIN floors f       ON f.id = r.floor_id
    LEFT JOIN buildings b    ON b.id = f.building_id
    LEFT JOIN departments dep ON dep.id = r.department_id
  `).all();

  const byId = new Map(devices.map((d) => [d.id, d]));
  const childrenOfDevice = new Map();
  const childrenOfSocket = new Map();
  for (const d of devices) {
    if (d.uplink_device_id) {
      if (!childrenOfDevice.has(d.uplink_device_id)) childrenOfDevice.set(d.uplink_device_id, []);
      childrenOfDevice.get(d.uplink_device_id).push(d);
    } else if (d.uplink_socket_id) {
      if (!childrenOfSocket.has(d.uplink_socket_id)) childrenOfSocket.set(d.uplink_socket_id, []);
      childrenOfSocket.get(d.uplink_socket_id).push(d);
    }
  }

  /** Всё, что висит ниже устройства, включая его самого. */
  function subtree(device, seen = new Set()) {
    if (seen.has(device.id)) return [];
    seen.add(device.id);
    const out = [device];
    for (const child of childrenOfDevice.get(device.id) || []) {
      out.push(...subtree(child, seen));
    }
    return out;
  }

  /** Всё, что подключено через розетку, на любую глубину. */
  function socketSubtree(socketId) {
    const out = [];
    const seen = new Set();
    for (const direct of childrenOfSocket.get(socketId) || []) {
      out.push(...subtree(direct, seen));
    }
    return out;
  }

  /** Путь от устройства вверх до порта Cisco, одной строкой. */
  function chainText(device) {
    const parts = [];
    let current = device;
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      parts.push(label(current.type));
      if (current.uplink_device_id) { current = byId.get(current.uplink_device_id); continue; }
      if (current.uplink_socket_id) {
        const sock = db.prepare(`
          SELECT s.label, p.port_number, sw.name AS switch_name
          FROM sockets s
          LEFT JOIN cisco_ports p     ON p.id = s.cisco_port_id
          LEFT JOIN cisco_switches sw ON sw.id = p.switch_id
          WHERE s.id = ?`).get(current.uplink_socket_id);
        if (sock) {
          parts.push(`розетка ${sock.label}`);
          if (sock.switch_name) parts.push(`${sock.switch_name}/${sock.port_number}`);
        }
      }
      break;
    }
    return parts.join(' → ');
  }

  return { devices, byId, childrenOfDevice, subtree, socketSubtree, chainText };
}

// =====================================================================
//  Реестры
// =====================================================================

function reportDevices(scope) {
  const { where, args } = scopeClause(scope);
  const topology = buildTopology();
  const filter = new Set(
    db.prepare(`
      SELECT d.id FROM devices d
      LEFT JOIN rooms r ON r.id = d.room_id
      LEFT JOIN floors f ON f.id = r.floor_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    `).all(...args).map((x) => x.id)
  );

  const rows = topology.devices
    .filter((d) => filter.has(d.id))
    .sort((a, b) =>
      (a.building_short || '').localeCompare(b.building_short || '', 'ru')
      || (a.floor_number || 0) - (b.floor_number || 0)
      || String(a.room_number || '').localeCompare(String(b.room_number || ''), 'ru', { numeric: true })
    )
    .map((d) => ({
      inventory_number: d.inventory_number,
      type: label(d.type),
      title: d.name || [d.manufacturer, d.model].filter(Boolean).join(' '),
      manufacturer: d.manufacturer,
      model: d.model,
      serial_number: d.serial_number,
      mac_address: d.mac_address,
      ip_address: d.ip_address,
      building: d.building_name,
      floor: d.floor_number,
      room_number: d.room_number,
      room_name: d.room_name,
      department: d.department_name,
      responsible: d.responsible_person,
      status: statusLabel(d.status),
      medium: mediumLabel(d.uplink_medium),
      connected: d.uplink_device_id || d.uplink_socket_id ? 'да' : 'нет',
      chain: topology.chainText(d),
    }));

  return {
    columns: [
      { key: 'inventory_number', title: 'Инв. номер' },
      { key: 'type', title: 'Тип' },
      { key: 'title', title: 'Наименование' },
      { key: 'manufacturer', title: 'Производитель' },
      { key: 'model', title: 'Модель' },
      { key: 'serial_number', title: 'Серийный номер' },
      { key: 'mac_address', title: 'MAC' },
      { key: 'ip_address', title: 'IP' },
      { key: 'building', title: 'Корпус' },
      { key: 'floor', title: 'Этаж', type: 'integer' },
      { key: 'room_number', title: 'Кабинет' },
      { key: 'room_name', title: 'Название кабинета' },
      { key: 'department', title: 'Отделение' },
      { key: 'responsible', title: 'Ответственный' },
      { key: 'status', title: 'Состояние' },
      { key: 'medium', title: 'Среда' },
      { key: 'connected', title: 'В сети' },
      { key: 'chain', title: 'Цепочка подключения', width: 60 },
    ],
    rows,
  };
}

function reportSockets(scope) {
  const { where, args } = scopeClause(scope);
  const rows = db.prepare(`
    SELECT s.label, r.room_number, r.name AS room_name, f.floor_number,
           b.name AS building_name, dep.name AS department_name,
           sw.name AS switch_name, p.port_number, p.status AS port_status, p.vlan,
           (SELECT COUNT(*) FROM devices d WHERE d.uplink_socket_id = s.id) AS devices_count,
           s.notes
    FROM sockets s
    JOIN rooms r      ON r.id = s.room_id
    JOIN floors f     ON f.id = r.floor_id
    JOIN buildings b  ON b.id = f.building_id
    LEFT JOIN departments dep   ON dep.id = r.department_id
    LEFT JOIN cisco_ports p     ON p.id = s.cisco_port_id
    LEFT JOIN cisco_switches sw ON sw.id = p.switch_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY b.sort_order, f.floor_number, CAST(r.room_number AS INTEGER), s.label
  `).all(...args).map((s) => ({
    ...s,
    port_status: s.port_status ? cat.PORT_STATUSES[s.port_status]?.label : '',
    linked: s.switch_name ? 'да' : 'нет',
  }));

  return {
    columns: [
      { key: 'label', title: 'Розетка' },
      { key: 'building_name', title: 'Корпус' },
      { key: 'floor_number', title: 'Этаж', type: 'integer' },
      { key: 'room_number', title: 'Кабинет' },
      { key: 'room_name', title: 'Название кабинета' },
      { key: 'department_name', title: 'Отделение' },
      { key: 'linked', title: 'Заведена на Cisco' },
      { key: 'switch_name', title: 'Коммутатор' },
      { key: 'port_number', title: 'Порт', type: 'integer' },
      { key: 'port_status', title: 'Состояние порта' },
      { key: 'vlan', title: 'VLAN' },
      { key: 'devices_count', title: 'Устройств', type: 'integer' },
      { key: 'notes', title: 'Примечание', width: 40 },
    ],
    rows,
  };
}

function reportPorts(scope) {
  const { where, args } = scopeClause(scope);
  // Порт попадает в выборку, если обслуживаемая им розетка входит в охват.
  // Незанятые порты остаются всегда: без них картина загрузки неполна.
  const clause = where.length
    ? `WHERE s.id IS NULL OR (${where.join(' AND ')})` : '';

  const rows = db.prepare(`
    SELECT sw.name AS switch_name, sw.model AS switch_model, p.port_number,
           p.status, p.vlan, p.notes,
           s.label AS socket_label, r.room_number, r.name AS room_name,
           f.floor_number, b.name AS building_name, dep.name AS department_name,
           (SELECT COUNT(*) FROM devices d WHERE d.uplink_socket_id = s.id) AS devices_direct
    FROM cisco_ports p
    JOIN cisco_switches sw ON sw.id = p.switch_id
    LEFT JOIN sockets s   ON s.cisco_port_id = p.id
    LEFT JOIN rooms r     ON r.id = s.room_id
    LEFT JOIN floors f    ON f.id = r.floor_id
    LEFT JOIN buildings b ON b.id = f.building_id
    LEFT JOIN departments dep ON dep.id = r.department_id
    ${clause}
    ORDER BY sw.sort_order, sw.name, p.port_number
  `).all(...args).map((p) => ({
    ...p,
    status: cat.PORT_STATUSES[p.status]?.label || p.status,
  }));

  return {
    columns: [
      { key: 'switch_name', title: 'Коммутатор' },
      { key: 'switch_model', title: 'Модель' },
      { key: 'port_number', title: 'Порт', type: 'integer' },
      { key: 'status', title: 'Состояние' },
      { key: 'socket_label', title: 'Розетка' },
      { key: 'building_name', title: 'Корпус' },
      { key: 'floor_number', title: 'Этаж', type: 'integer' },
      { key: 'room_number', title: 'Кабинет' },
      { key: 'department_name', title: 'Отделение' },
      { key: 'devices_direct', title: 'Устройств в розетке', type: 'integer' },
      { key: 'vlan', title: 'VLAN' },
      { key: 'notes', title: 'Примечание', width: 36 },
    ],
    rows,
  };
}

function reportRooms(scope) {
  const { where, args } = scopeClause(scope);
  const rows = db.prepare(`
    SELECT r.room_number, r.name, r.area, f.floor_number, b.name AS building_name,
           dep.name AS department_name, dep.head_person,
           (SELECT COUNT(*) FROM sockets s WHERE s.room_id = r.id) AS sockets_count,
           (SELECT COUNT(*) FROM devices d WHERE d.room_id = r.id) AS devices_count,
           CASE WHEN r.svg_polygon_id IS NULL THEN 'нет' ELSE 'да' END AS on_plan,
           r.notes
    FROM rooms r
    JOIN floors f    ON f.id = r.floor_id
    JOIN buildings b ON b.id = f.building_id
    LEFT JOIN departments dep ON dep.id = r.department_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY b.sort_order, f.floor_number, CAST(r.room_number AS INTEGER)
  `).all(...args);

  return {
    columns: [
      { key: 'room_number', title: 'Номер' },
      { key: 'name', title: 'Название' },
      { key: 'building_name', title: 'Корпус' },
      { key: 'floor_number', title: 'Этаж', type: 'integer' },
      { key: 'department_name', title: 'Отделение' },
      { key: 'head_person', title: 'Ответственный отделения' },
      { key: 'area', title: 'Площадь, м²', type: 'number' },
      { key: 'sockets_count', title: 'Розеток', type: 'integer' },
      { key: 'devices_count', title: 'Устройств', type: 'integer' },
      { key: 'on_plan', title: 'На плане' },
      { key: 'notes', title: 'Примечание', width: 36 },
    ],
    rows,
  };
}

function reportChangelog(scope) {
  const where = [];
  const args = [];
  if (scope.from) { where.push('at >= ?'); args.push(String(scope.from)); }
  if (scope.to)   { where.push('at <= ?'); args.push(String(scope.to) + ' 23:59:59'); }

  const ACTIONS = {
    create: 'создание', update: 'изменение', delete: 'удаление',
    move: 'перемещение', connect: 'подключение',
  };
  const ENTITIES = {
    device: 'оборудование', socket: 'розетка', room: 'помещение',
    building: 'корпус', floor: 'этаж', department: 'отделение',
    cisco_switch: 'коммутатор', cisco_port: 'порт',
  };

  const rows = db.prepare(`
    SELECT at, username, entity, entity_id, action, summary FROM change_log
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT 20000
  `).all(...args).map((r) => ({
    ...r,
    entity: ENTITIES[r.entity] || r.entity,
    action: ACTIONS[r.action] || r.action,
  }));

  return {
    columns: [
      { key: 'at', title: 'Дата и время' },
      { key: 'username', title: 'Пользователь' },
      { key: 'entity', title: 'Объект' },
      { key: 'entity_id', title: 'Номер записи', type: 'integer' },
      { key: 'action', title: 'Действие' },
      { key: 'summary', title: 'Что изменилось', width: 56 },
    ],
    rows,
  };
}

// =====================================================================
//  Сводки
// =====================================================================

/** Общая заготовка: считает устройства в разрезе произвольного признака. */
function crossTab(scope, groupSql, groupTitle, groupOrder) {
  const { where, args } = scopeClause(scope);
  const rows = db.prepare(`
    SELECT ${groupSql} AS grp,
           COUNT(*) AS total,
           SUM(CASE WHEN d.status = 'in_use' THEN 1 ELSE 0 END) AS in_use,
           SUM(CASE WHEN d.status = 'spare' THEN 1 ELSE 0 END) AS spare,
           SUM(CASE WHEN d.status = 'repair' THEN 1 ELSE 0 END) AS repair,
           SUM(CASE WHEN d.status = 'written_off' THEN 1 ELSE 0 END) AS written_off,
           SUM(CASE WHEN d.uplink_socket_id IS NOT NULL OR d.uplink_device_id IS NOT NULL
                    THEN 1 ELSE 0 END) AS connected,
           SUM(CASE WHEN d.mac_address IS NOT NULL AND d.mac_address <> '' THEN 1 ELSE 0 END) AS with_mac
    FROM devices d
    LEFT JOIN rooms r  ON r.id = d.room_id
    LEFT JOIN floors f ON f.id = r.floor_id
    LEFT JOIN buildings b ON b.id = f.building_id
    LEFT JOIN departments dep ON dep.id = r.department_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    GROUP BY grp
    ORDER BY ${groupOrder || 'total DESC'}
  `).all(...args);

  const totals = {
    grp: 'ИТОГО', total: 0, in_use: 0, spare: 0, repair: 0,
    written_off: 0, connected: 0, with_mac: 0,
  };
  for (const row of rows) {
    for (const key of ['total', 'in_use', 'spare', 'repair', 'written_off', 'connected', 'with_mac']) {
      totals[key] += row[key];
    }
  }
  if (rows.length) rows.push(totals);

  return {
    columns: [
      { key: 'grp', title: groupTitle, width: 34 },
      { key: 'total', title: 'Всего', type: 'integer' },
      { key: 'in_use', title: 'В работе', type: 'integer' },
      { key: 'spare', title: 'В резерве', type: 'integer' },
      { key: 'repair', title: 'В ремонте', type: 'integer' },
      { key: 'written_off', title: 'Списано', type: 'integer' },
      { key: 'connected', title: 'Подключено', type: 'integer' },
      { key: 'with_mac', title: 'С MAC-адресом', type: 'integer' },
    ],
    rows: rows.map((r) => ({ ...r, grp: r.grp || 'не указано' })),
  };
}

function reportByStatus(scope) {
  return crossTab(scope, 'IFNULL(dep.name, «без отделения»)'.replace(/«|»/g, "'"),
    'Отделение', 'total DESC');
}

function reportByType(scope) {
  const result = crossTab(scope, 'd.type', 'Тип оборудования', 'total DESC');
  result.rows = result.rows.map((r) => ({
    ...r, grp: r.grp === 'ИТОГО' ? r.grp : label(r.grp),
  }));
  return result;
}

function reportByBuilding(scope) {
  return crossTab(scope,
    "IFNULL(b.name, 'вне помещений') || CASE WHEN f.floor_number IS NULL THEN '' " +
    "ELSE ', ' || f.floor_number || ' этаж' END",
    'Корпус и этаж', 'grp');
}

function reportByResponsible(scope) {
  const { where, args } = scopeClause(scope);
  const rows = db.prepare(`
    SELECT IFNULL(NULLIF(d.responsible_person, ''), 'не назначен') AS person,
           COUNT(*) AS total,
           COUNT(DISTINCT d.room_id) AS rooms_count,
           COUNT(DISTINCT r.department_id) AS departments_count,
           SUM(CASE WHEN d.status = 'in_use' THEN 1 ELSE 0 END) AS in_use,
           SUM(CASE WHEN d.status = 'repair' THEN 1 ELSE 0 END) AS repair,
           SUM(CASE WHEN d.inventory_number IS NULL OR d.inventory_number = ''
                    THEN 1 ELSE 0 END) AS without_inventory
    FROM devices d
    LEFT JOIN rooms r  ON r.id = d.room_id
    LEFT JOIN floors f ON f.id = r.floor_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    GROUP BY person ORDER BY total DESC
  `).all(...args);

  return {
    columns: [
      { key: 'person', title: 'Ответственный', width: 30 },
      { key: 'total', title: 'Всего единиц', type: 'integer' },
      { key: 'in_use', title: 'В работе', type: 'integer' },
      { key: 'repair', title: 'В ремонте', type: 'integer' },
      { key: 'rooms_count', title: 'Кабинетов', type: 'integer' },
      { key: 'departments_count', title: 'Отделений', type: 'integer' },
      { key: 'without_inventory', title: 'Без инв. номера', type: 'integer' },
    ],
    rows,
  };
}

function reportByDepartment(scope) {
  const { where, args } = scopeClause(scope);
  const rows = db.prepare(`
    SELECT IFNULL(dep.name, 'без отделения') AS department,
           dep.head_person, dep.phone,
           COUNT(DISTINCT r.id) AS rooms_count,
           (SELECT COUNT(*) FROM sockets s WHERE s.room_id IN
             (SELECT id FROM rooms x WHERE IFNULL(x.department_id, -1) = IFNULL(dep.id, -1))
           ) AS sockets_count,
           (SELECT COUNT(*) FROM devices d2 JOIN rooms r2 ON r2.id = d2.room_id
             WHERE IFNULL(r2.department_id, -1) = IFNULL(dep.id, -1)) AS devices_count
    FROM rooms r
    JOIN floors f ON f.id = r.floor_id
    LEFT JOIN departments dep ON dep.id = r.department_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    GROUP BY IFNULL(dep.id, -1)
    ORDER BY devices_count DESC
  `).all(...args);

  return {
    columns: [
      { key: 'department', title: 'Отделение', width: 34 },
      { key: 'head_person', title: 'Ответственный' },
      { key: 'phone', title: 'Телефон' },
      { key: 'rooms_count', title: 'Кабинетов', type: 'integer' },
      { key: 'sockets_count', title: 'Розеток', type: 'integer' },
      { key: 'devices_count', title: 'Устройств', type: 'integer' },
    ],
    rows,
  };
}

function reportConnectivity(scope) {
  const { where, args } = scopeClause(scope);
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const one = (extra) => db.prepare(`
    SELECT COUNT(*) AS n FROM devices d
    LEFT JOIN rooms r ON r.id = d.room_id
    LEFT JOIN floors f ON f.id = r.floor_id
    ${clause}${clause ? ' AND ' : 'WHERE '}${extra}
  `).get(...args).n;

  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM devices d
    LEFT JOIN rooms r ON r.id = d.room_id
    LEFT JOIN floors f ON f.id = r.floor_id ${clause}
  `).get(...args).n;

  const rows = [
    { metric: 'Всего оборудования', value: total },
    { metric: 'Подключено в розетку напрямую', value: one('d.uplink_socket_id IS NOT NULL') },
    { metric: 'Подключено через другое устройство', value: one('d.uplink_device_id IS NOT NULL') },
    { metric: '  из них по Ethernet', value: one("d.uplink_medium = 'ethernet' AND d.uplink_device_id IS NOT NULL") },
    { metric: '  из них по USB', value: one("d.uplink_medium = 'usb'") },
    { metric: '  из них по Wi-Fi', value: one("d.uplink_medium = 'wifi'") },
    { metric: 'Не подключено никуда', value: one('d.uplink_socket_id IS NULL AND d.uplink_device_id IS NULL') },
    { metric: 'Имеют MAC-адрес', value: one("d.mac_address IS NOT NULL AND d.mac_address <> ''") },
    { metric: 'Имеют IP-адрес', value: one("d.ip_address IS NOT NULL AND d.ip_address <> ''") },
  ].map((r) => ({ ...r, share: total ? Math.round((r.value / total) * 1000) / 10 : 0 }));

  return {
    columns: [
      { key: 'metric', title: 'Показатель', width: 40 },
      { key: 'value', title: 'Количество', type: 'integer' },
      { key: 'share', title: 'Доля от всего, %', type: 'number' },
    ],
    rows,
  };
}

function reportSwitchLoad() {
  const rows = db.prepare(`
    SELECT sw.name, sw.model, sw.ip_address, sw.location, sw.total_ports,
           SUM(CASE WHEN p.status = 'active' THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN p.status = 'free' THEN 1 ELSE 0 END) AS free,
           SUM(CASE WHEN p.status = 'reserved' THEN 1 ELSE 0 END) AS reserved,
           SUM(CASE WHEN p.status = 'damaged' THEN 1 ELSE 0 END) AS damaged,
           SUM(CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END) AS with_socket
    FROM cisco_switches sw
    LEFT JOIN cisco_ports p ON p.switch_id = sw.id
    LEFT JOIN sockets s     ON s.cisco_port_id = p.id
    GROUP BY sw.id ORDER BY sw.sort_order, sw.name
  `).all().map((sw) => ({
    ...sw,
    load: sw.total_ports ? Math.round((sw.active / sw.total_ports) * 1000) / 10 : 0,
  }));

  const totals = rows.reduce((acc, sw) => {
    for (const key of ['total_ports', 'active', 'free', 'reserved', 'damaged', 'with_socket']) {
      acc[key] += sw[key] || 0;
    }
    return acc;
  }, { name: 'ИТОГО', total_ports: 0, active: 0, free: 0, reserved: 0, damaged: 0, with_socket: 0 });
  totals.load = totals.total_ports
    ? Math.round((totals.active / totals.total_ports) * 1000) / 10 : 0;
  if (rows.length) rows.push(totals);

  return {
    note: 'Коммутаторы относятся ко всей организации, охват на этот лист не влияет.',
    columns: [
      { key: 'name', title: 'Коммутатор' },
      { key: 'model', title: 'Модель' },
      { key: 'ip_address', title: 'IP-адрес' },
      { key: 'location', title: 'Расположение' },
      { key: 'total_ports', title: 'Портов всего', type: 'integer' },
      { key: 'active', title: 'Занято', type: 'integer' },
      { key: 'free', title: 'Свободно', type: 'integer' },
      { key: 'reserved', title: 'Резерв', type: 'integer' },
      { key: 'damaged', title: 'Повреждено', type: 'integer' },
      { key: 'with_socket', title: 'Заведено розеток', type: 'integer' },
      { key: 'load', title: 'Загрузка, %', type: 'number' },
    ],
    rows,
  };
}

// =====================================================================
//  MAC-адреса на портах: сколько адресов должен видеть каждый порт
// =====================================================================

/**
 * За розеткой может стоять неуправляемый коммутатор, а за ним ещё
 * несколько устройств. Порт Cisco увидит MAC-адреса всех из них.
 * Считаем ожидаемое число адресов обходом поддерева вниз - это то
 * значение, с которым сверяется вывод команды show mac address-table.
 */
function computePortLoad(scope) {
  const topology = buildTopology();
  const { where, args } = scopeClause(scope);
  const clause = where.length ? `WHERE s.id IS NULL OR (${where.join(' AND ')})` : '';

  const ports = db.prepare(`
    SELECT p.id, p.port_number, p.status, p.vlan,
           sw.name AS switch_name, sw.sort_order,
           s.id AS socket_id, s.label AS socket_label,
           r.room_number, r.name AS room_name, f.floor_number,
           b.short_name AS building_short, dep.name AS department_name
    FROM cisco_ports p
    JOIN cisco_switches sw ON sw.id = p.switch_id
    LEFT JOIN sockets s   ON s.cisco_port_id = p.id
    LEFT JOIN rooms r     ON r.id = s.room_id
    LEFT JOIN floors f    ON f.id = r.floor_id
    LEFT JOIN buildings b ON b.id = f.building_id
    LEFT JOIN departments dep ON dep.id = r.department_id
    ${clause}
    ORDER BY sw.sort_order, sw.name, p.port_number
  `).all(...args);

  return ports.map((port) => {
    const subtree = port.socket_id ? topology.socketSubtree(port.socket_id) : [];
    const withMac = subtree.filter((d) => d.mac_address && String(d.mac_address).trim());
    const hubs = subtree.filter((d) => d.type === 'switch' || d.type === 'router');
    return {
      ...port,
      status: cat.PORT_STATUSES[port.status]?.label || port.status,
      devices_total: subtree.length,
      expected_macs: withMac.length,
      hubs: hubs.length,
      hub_names: hubs.map((h) => [h.manufacturer, h.model].filter(Boolean).join(' ')).join('; '),
      mac_list: withMac.map((d) => d.mac_address).join(' '),
      types: [...new Set(subtree.map((d) => label(d.type)))].join(', '),
    };
  });
}

function reportPortMacs(scope) {
  const rows = computePortLoad(scope).filter((p) => p.socket_id);
  return {
    note: 'Ожидаемое число MAC-адресов на порту — сверяйте с выводом ' +
          'команды show mac address-table на коммутаторе. Расхождение означает ' +
          'подключённое оборудование, не учтённое в системе.',
    columns: [
      { key: 'switch_name', title: 'Коммутатор' },
      { key: 'port_number', title: 'Порт', type: 'integer' },
      { key: 'status', title: 'Состояние' },
      { key: 'socket_label', title: 'Розетка' },
      { key: 'building_short', title: 'Корпус' },
      { key: 'floor_number', title: 'Этаж', type: 'integer' },
      { key: 'room_number', title: 'Кабинет' },
      { key: 'department_name', title: 'Отделение' },
      { key: 'devices_total', title: 'Устройств за портом', type: 'integer' },
      { key: 'expected_macs', title: 'Ожидается MAC-адресов', type: 'integer' },
      { key: 'hubs', title: 'Свитчей и роутеров', type: 'integer' },
      { key: 'hub_names', title: 'Какие именно', width: 34 },
      { key: 'types', title: 'Состав', width: 40 },
      { key: 'mac_list', title: 'MAC-адреса', width: 60 },
    ],
    rows,
  };
}

function reportPortDistribution(scope) {
  const ports = computePortLoad(scope);
  const buckets = [
    { key: 'Порт свободен (розетка не заведена)', test: (p) => !p.socket_id },
    { key: 'Розетка есть, устройств нет', test: (p) => p.socket_id && p.devices_total === 0 },
    { key: 'Одно устройство', test: (p) => p.devices_total === 1 },
    { key: '2–4 устройства', test: (p) => p.devices_total >= 2 && p.devices_total <= 4 },
    { key: '5 и более устройств', test: (p) => p.devices_total >= 5 },
  ];

  const rows = buckets.map((bucket) => {
    const matched = ports.filter(bucket.test);
    return {
      bucket: bucket.key,
      ports: matched.length,
      share: ports.length ? Math.round((matched.length / ports.length) * 1000) / 10 : 0,
      devices: matched.reduce((n, p) => n + p.devices_total, 0),
      macs: matched.reduce((n, p) => n + p.expected_macs, 0),
    };
  });

  const withHubs = ports.filter((p) => p.hubs > 0);
  rows.push({
    bucket: 'Из них с неуправляемым свитчом или роутером',
    ports: withHubs.length,
    share: ports.length ? Math.round((withHubs.length / ports.length) * 1000) / 10 : 0,
    devices: withHubs.reduce((n, p) => n + p.devices_total, 0),
    macs: withHubs.reduce((n, p) => n + p.expected_macs, 0),
  });

  return {
    note: 'Порты с пятью и более устройствами почти всегда означают ' +
          'неучтённый коммутатор в кабинете — их стоит проверить в первую очередь.',
    columns: [
      { key: 'bucket', title: 'Группа портов', width: 44 },
      { key: 'ports', title: 'Портов', type: 'integer' },
      { key: 'share', title: 'Доля, %', type: 'number' },
      { key: 'devices', title: 'Устройств', type: 'integer' },
      { key: 'macs', title: 'MAC-адресов', type: 'integer' },
    ],
    rows,
  };
}

// =====================================================================
//  Качество данных
// =====================================================================

function reportQuality(scope) {
  const { where, args } = scopeClause(scope);
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const withAnd = (extra) => `${clause}${clause ? ' AND ' : 'WHERE '}${extra}`;

  const countDevices = (extra) => db.prepare(`
    SELECT COUNT(*) AS n FROM devices d
    LEFT JOIN rooms r ON r.id = d.room_id
    LEFT JOIN floors f ON f.id = r.floor_id ${withAnd(extra)}
  `).get(...args).n;

  const countSockets = (extra) => db.prepare(`
    SELECT COUNT(*) AS n FROM sockets s
    JOIN rooms r ON r.id = s.room_id
    JOIN floors f ON f.id = r.floor_id ${withAnd(extra)}
  `).get(...args).n;

  const countRooms = (extra) => db.prepare(`
    SELECT COUNT(*) AS n FROM rooms r
    JOIN floors f ON f.id = r.floor_id ${withAnd(extra)}
  `).get(...args).n;

  let invalidLinks = 0;
  try {
    invalidLinks = require('./integrity').findInvalidLinks().length;
  } catch { /* модуль ревизии недоступен - не критично */ }

  const rows = [
    { issue: 'Оборудование без инвентарного номера', count: countDevices("d.inventory_number IS NULL OR d.inventory_number = ''"), why: 'не пройдёт сверку с бухгалтерией' },
    { issue: 'Оборудование без серийного номера', count: countDevices("d.serial_number IS NULL OR d.serial_number = ''"), why: 'сложно идентифицировать при ремонте' },
    { issue: 'Сетевое оборудование без MAC-адреса', count: countDevices("(d.mac_address IS NULL OR d.mac_address = '') AND (d.uplink_socket_id IS NOT NULL OR d.uplink_device_id IS NOT NULL) AND d.uplink_medium <> 'usb'"), why: 'нельзя сверить с таблицей коммутатора' },
    { issue: 'Оборудование без ответственного', count: countDevices("d.responsible_person IS NULL OR d.responsible_person = ''"), why: 'некому предъявить при инвентаризации' },
    { issue: 'Оборудование вне помещений', count: countDevices('d.room_id IS NULL'), why: 'числится на складе или потеряно' },
    { issue: 'Оборудование не подключено', count: countDevices('d.uplink_socket_id IS NULL AND d.uplink_device_id IS NULL'), why: 'резерв, ремонт либо незаполненные данные' },
    { issue: 'Оборудование не размещено на плане', count: countDevices('(d.pos_x IS NULL OR d.pos_y IS NULL) AND d.room_id IS NOT NULL'), why: 'не видно на карте' },
    { issue: 'Розетки без линии до коммутатора', count: countSockets('s.cisco_port_id IS NULL'), why: 'разрыв цепочки прослеживаемости' },
    { issue: 'Помещения без привязки к плану', count: countRooms('r.svg_polygon_id IS NULL'), why: 'не отображаются на карте' },
    { issue: 'Помещения без отделения', count: countRooms('r.department_id IS NULL'), why: 'не попадут в отчёты по отделениям' },
    { issue: 'Повреждённые порты коммутаторов', count: db.prepare("SELECT COUNT(*) AS n FROM cisco_ports WHERE status = 'damaged'").get().n, why: 'требуют ремонта линии' },
    { issue: 'Связи, нарушающие правила совместимости', count: invalidLinks, why: 'проверьте командой npm run check' },
  ];

  return {
    note: 'Список того, что стоит дозаполнить. Нули в правом столбце — хороший знак.',
    columns: [
      { key: 'issue', title: 'Что не заполнено или требует внимания', width: 48 },
      { key: 'count', title: 'Записей', type: 'integer' },
      { key: 'why', title: 'Почему это важно', width: 44 },
    ],
    rows,
  };
}

// =====================================================================
//  Реестр отчётов
// =====================================================================

const REPORTS = [
  { key: 'devices', group: 'Реестры', title: 'Оборудование', description: 'Полный перечень: реквизиты, размещение, цепочка подключения', build: reportDevices },
  { key: 'sockets', group: 'Реестры', title: 'Розетки', description: 'Все розетки с привязкой к портам коммутаторов', build: reportSockets },
  { key: 'ports', group: 'Реестры', title: 'Порты Cisco', description: 'Все порты магистральных коммутаторов и что за ними', build: reportPorts },
  { key: 'rooms', group: 'Реестры', title: 'Помещения', description: 'Кабинеты с числом розеток и устройств', build: reportRooms },
  { key: 'changelog', group: 'Реестры', title: 'Журнал изменений', description: 'Кто и что правил; можно ограничить периодом', build: reportChangelog, period: true },

  { key: 'by_status', group: 'Сводки', title: 'По состоянию и отделениям', description: 'В работе, резерв, ремонт, списано — в разрезе отделений', build: reportByStatus },
  { key: 'by_type', group: 'Сводки', title: 'По типам оборудования', description: 'Сколько каких устройств и в каком они состоянии', build: reportByType },
  { key: 'by_building', group: 'Сводки', title: 'По корпусам и этажам', description: 'Распределение по зданию', build: reportByBuilding },
  { key: 'by_department', group: 'Сводки', title: 'По отделениям', description: 'Кабинеты, розетки, устройства, ответственные', build: reportByDepartment },
  { key: 'by_responsible', group: 'Сводки', title: 'По ответственным', description: 'Сколько единиц числится за каждым сотрудником', build: reportByResponsible },
  { key: 'connectivity', group: 'Сводки', title: 'Подключённость', description: 'Сколько в сети, по какой среде, сколько без связи', build: reportConnectivity },

  { key: 'switch_load', group: 'Сеть', title: 'Загрузка коммутаторов', description: 'Занятые и свободные порты по каждому Cisco', build: reportSwitchLoad },
  { key: 'port_macs', group: 'Сеть', title: 'MAC-адреса на портах', description: 'Сколько адресов должен видеть каждый порт — для сверки с show mac address-table', build: reportPortMacs },
  { key: 'port_distribution', group: 'Сеть', title: 'Распределение портов', description: 'Группировка портов по числу устройств за ними', build: reportPortDistribution },

  { key: 'quality', group: 'Контроль', title: 'Качество данных', description: 'Что не заполнено и требует внимания', build: reportQuality },
];

function findReport(key) {
  return REPORTS.find((r) => r.key === key) || null;
}

/** Список отчётов для интерфейса, без построителей. */
function listReports() {
  return REPORTS.map(({ key, group, title, description, period }) =>
    ({ key, group, title, description, period: !!period }));
}

function buildReport(key, scope) {
  const report = findReport(key);
  if (!report) return null;
  const result = report.build(scope);
  return { ...result, title: report.title, key };
}

// =====================================================================
//  Выгрузка
// =====================================================================

/** CSV с разделителем «;» - Excel открывает такой файл без мастера импорта. */
function toCsv({ columns, rows }) {
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map((c) => escape(c.title)).join(';')];
  for (const row of rows) lines.push(columns.map((c) => escape(row[c.key])).join(';'));
  return '\uFEFF' + lines.join('\r\n');
}

/** Книга XLSX со всеми отчётами: по листу на каждый. */
function buildWorkbook(scope, keys) {
  const book = new Workbook();
  const note = describeScope(scope);
  const selected = keys && keys.length
    ? REPORTS.filter((r) => keys.includes(r.key)) : REPORTS;

  for (const report of selected) {
    const data = report.build(scope);
    book.addSheet(report.title, data.columns, data.rows, {
      note: data.note ? `${note}. ${data.note}` : note,
    });
  }

  // Динамика по месяцам добавляется отдельно: у неё своя структура
  try {
    const { snapshotTable } = require('./snapshots');
    const dynamics = snapshotTable();
    if (dynamics.rows.length) {
      book.addSheet('Динамика по месяцам', dynamics.columns, dynamics.rows, {
        note: 'Срезы снимаются автоматически один раз в месяц при первом запуске сервера.',
      });
    }
  } catch { /* модуль срезов недоступен */ }

  return book.toBuffer();
}

module.exports = {
  REPORTS, listReports, findReport, buildReport, buildWorkbook,
  toCsv, describeScope, computePortLoad,
};
