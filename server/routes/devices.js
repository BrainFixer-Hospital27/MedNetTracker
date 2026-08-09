'use strict';
const express = require('express');
const { db, logChange } = require('../db');
const { pick, update, insert, notFound, badRequest } = require('../crud');
const cat = require('../catalog');
const model = require('../model');
const { syncPortStatus } = model;

const router = express.Router();

const DEVICE_FIELDS = [
  'room_id', 'type', 'name', 'manufacturer', 'model', 'serial_number',
  'inventory_number', 'mac_address', 'ip_address', 'responsible_person',
  'status', 'notes', 'pos_x', 'pos_y', 'ports_count',
  'router_login', 'router_password', 'wifi_ssid', 'wifi_password', 'cartridge_model',
];

// ---------------------------------------------------------------------
//  Разбор фильтров: используется и списком, и выгрузкой в CSV
// ---------------------------------------------------------------------
function buildFilter(query) {
  const where = [];
  const args = [];

  if (query.type) {
    const types = String(query.type).split(',').filter(Boolean);
    where.push(`d.type IN (${types.map(() => '?').join(',')})`);
    args.push(...types);
  }
  if (query.layer) {
    const layers = String(query.layer).split(',').filter(Boolean);
    const types = Object.entries(cat.DEVICE_TYPES)
      .filter(([, m]) => layers.includes(m.layer)).map(([k]) => k);
    if (types.length) {
      where.push(`d.type IN (${types.map(() => '?').join(',')})`);
      args.push(...types);
    } else where.push('1 = 0');
  }
  if (query.status) {
    const st = String(query.status).split(',').filter(Boolean);
    where.push(`d.status IN (${st.map(() => '?').join(',')})`);
    args.push(...st);
  }
  if (query.room_id)       { where.push('d.room_id = ?');       args.push(query.room_id); }
  if (query.floor_id)      { where.push('r.floor_id = ?');      args.push(query.floor_id); }
  if (query.building_id)   { where.push('f.building_id = ?');   args.push(query.building_id); }
  if (query.department_id) { where.push('r.department_id = ?'); args.push(query.department_id); }

  if (query.connected === 'yes') {
    where.push('(d.uplink_socket_id IS NOT NULL OR d.uplink_device_id IS NOT NULL)');
  } else if (query.connected === 'no') {
    where.push('d.uplink_socket_id IS NULL AND d.uplink_device_id IS NULL');
  }
  if (query.unplaced === 'yes') where.push('(d.pos_x IS NULL OR d.pos_y IS NULL)');
  // Оборудование, не привязанное ни к какому помещению: склад,
  // заказанное, запланированное
  if (query.no_room === 'yes') where.push('d.room_id IS NULL');

  if (query.q) {
    const q = `%${String(query.q).trim().toLowerCase()}%`;
    where.push(`(
      lc(IFNULL(d.inventory_number,'')) LIKE ? OR
      lc(IFNULL(d.serial_number,''))    LIKE ? OR
      lc(IFNULL(d.mac_address,''))      LIKE ? OR
      lc(IFNULL(d.ip_address,''))       LIKE ? OR
      lc(IFNULL(d.name,''))             LIKE ? OR
      lc(IFNULL(d.model,''))            LIKE ? OR
      lc(IFNULL(d.manufacturer,''))     LIKE ? OR
      lc(IFNULL(d.responsible_person,'')) LIKE ? OR
      lc(IFNULL(r.room_number,''))      LIKE ?
    )`);
    args.push(q, q, q, q, q, q, q, q, q);
  }

  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

const LIST_SELECT = `
  SELECT d.*,
         r.room_number, r.name AS room_name, r.floor_id,
         f.floor_number, f.building_id, b.name AS building_name, b.short_name AS building_short,
         dep.id AS department_id, dep.name AS department_name, dep.color AS department_color,
         sock.label AS uplink_socket_label,
         par.name  AS uplink_device_name, par.type AS uplink_device_type,
         par.model AS uplink_device_model
  FROM devices d
  LEFT JOIN rooms r        ON r.id = d.room_id
  LEFT JOIN floors f       ON f.id = r.floor_id
  LEFT JOIN buildings b    ON b.id = f.building_id
  LEFT JOIN departments dep ON dep.id = r.department_id
  LEFT JOIN sockets sock   ON sock.id = d.uplink_socket_id
  LEFT JOIN devices par    ON par.id = d.uplink_device_id
`;

const SORTABLE = {
  inventory_number: 'd.inventory_number', type: 'd.type', model: 'd.model',
  room: 'CAST(r.room_number AS INTEGER)', department: 'dep.name',
  responsible: 'd.responsible_person', status: 'd.status', updated: 'd.updated_at',
};

// ---------------------------------------------------------------------
//  Список с фильтрами и постраничным выводом
// ---------------------------------------------------------------------
router.get('/', (req, res) => {
  const { clause, args } = buildFilter(req.query);

  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM devices d
    LEFT JOIN rooms r ON r.id = d.room_id
    LEFT JOIN floors f ON f.id = r.floor_id
    ${clause}
  `).get(...args).n;

  const perPage = Math.min(Number(req.query.per_page) || 50, 500);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const sortKey = SORTABLE[req.query.sort] || 'd.id';
  const dir = String(req.query.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const rows = db.prepare(`
    ${LIST_SELECT} ${clause}
    ORDER BY ${sortKey} ${dir}, d.id ASC
    LIMIT ? OFFSET ?
  `).all(...args, perPage, (page - 1) * perPage);

  res.json({
    devices: rows.map((r) => model.serializeDevice(r)),
    total, page, per_page: perPage,
    pages: Math.max(Math.ceil(total / perPage), 1),
  });
});

// ---------------------------------------------------------------------
//  Выгрузка реестра. Разделитель ';' и BOM - чтобы Excel открыл
//  файл сразу правильно, без мастера импорта.
// ---------------------------------------------------------------------
router.get('/export.csv', (req, res) => {
  const { clause, args } = buildFilter(req.query);
  const rows = db.prepare(`${LIST_SELECT} ${clause}
    ORDER BY b.sort_order, f.floor_number, CAST(r.room_number AS INTEGER), d.id`).all(...args);

  const columns = [
    ['Инв. номер', (d) => d.inventory_number],
    ['Тип', (d) => cat.DEVICE_TYPES[d.type]?.label || d.type],
    ['Название', (d) => model.deviceTitle(d)],
    ['Производитель', (d) => d.manufacturer],
    ['Модель', (d) => d.model],
    ['Серийный номер', (d) => d.serial_number],
    ['MAC', (d) => d.mac_address],
    ['IP', (d) => d.ip_address],
    ['Корпус', (d) => d.building_name],
    ['Этаж', (d) => d.floor_number],
    ['Помещение', (d) => d.room_number],
    ['Название помещения', (d) => d.room_name],
    ['Отделение', (d) => d.department_name],
    ['Ответственный', (d) => d.responsible_person],
    ['Состояние', (d) => cat.DEVICE_STATUSES[d.status]?.label || d.status],
    ['Подключено к', (d) => connectionLabel(d)],
    ['Порт Cisco', (d) => ciscoLabel(d)],
    ['Примечание', (d) => d.notes],
  ];

  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [columns.map((c) => esc(c[0])).join(';')];
  for (const row of rows) lines.push(columns.map((c) => esc(c[1](row))).join(';'));

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="mednet-devices-${stamp}.csv"`);
  res.send('\uFEFF' + lines.join('\r\n'));
});

function connectionLabel(d) {
  if (d.uplink_socket_label) return `розетка ${d.uplink_socket_label}`;
  if (d.uplink_device_id) {
    const t = cat.DEVICE_TYPES[d.uplink_device_type]?.short || '';
    return [t, d.uplink_device_name || d.uplink_device_model].filter(Boolean).join(' ');
  }
  return '';
}

/** Ищет порт Cisco на конце цепочки - для колонки выгрузки. */
function ciscoLabel(d) {
  const chain = model.buildChain(d.id);
  const port = chain.find((l) => l.kind === 'cisco_port');
  return port ? port.label : '';
}

// ---------------------------------------------------------------------
//  Карточка устройства целиком
// ---------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const row = db.prepare(`${LIST_SELECT} WHERE d.id = ?`).get(req.params.id);
  if (!row) return notFound(res, 'Устройство');

  res.json({
    device: model.serializeDevice(row, true),
    place: model.placeChain(row.room_id),
    chain: model.buildChain(row.id),
    children: model.childrenOf(row.id),
    port_usage: model.portUsage(row.id),
  });
});

// ---------------------------------------------------------------------
//  Создание
// ---------------------------------------------------------------------
router.post('/', (req, res) => {
  const data = pick(req.body, DEVICE_FIELDS);
  if (!data.type || !cat.DEVICE_TYPES[data.type]) {
    return badRequest(res, 'Не указан или неизвестен тип оборудования');
  }
  if (data.room_id && !db.prepare('SELECT id FROM rooms WHERE id = ?').get(data.room_id)) {
    return badRequest(res, 'Указанное помещение не найдено');
  }
  if (!data.status) data.status = 'in_use';

  const id = insert('devices', data);

  // Подключение, если пришло вместе с созданием
  if (req.body.uplink && req.body.uplink.kind && req.body.uplink.kind !== 'none') {
    const check = model.validateConnection(id, req.body.uplink);
    if (!check.ok) {
      // Устройство уже создано, но подключить его так нельзя.
      // Сообщаем об этом явно, а не оставляем связь молча пустой.
      logChange(req, 'device', id, 'create', 'создано без подключения: ' + check.message);
      return res.status(201).json({
        device: model.getDevice(id, true),
        connection_rejected: check.message,
      });
    }
    update('devices', id, model.uplinkColumns(req.body.uplink, check.medium));
    syncPortStatus(req.body.uplink);
  }

  logChange(req, 'device', id, 'create',
    `${cat.DEVICE_TYPES[data.type].label} ${data.inventory_number || ''}`.trim());
  res.status(201).json({ device: model.getDevice(id, true) });
});

// ---------------------------------------------------------------------
//  Изменение. Одним запросом можно и подвинуть иконку, и сменить
//  помещение, и переподключить - фронт этим пользуется при перетаскивании.
// ---------------------------------------------------------------------
router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, 'Устройство');

  const data = pick(req.body, DEVICE_FIELDS);
  if (data.type && !cat.DEVICE_TYPES[data.type]) {
    return badRequest(res, 'Неизвестный тип оборудования');
  }

  // Смена типа способна сделать недопустимыми уже существующие связи.
  // Молча их рвать нельзя - это потеря учётных данных, поэтому
  // отказываем и объясняем, что мешает.
  if (data.type && data.type !== row.type && req.body.uplink === undefined) {
    const problems = model.validateTypeChange(row.id, data.type);
    if (problems.length) {
      return res.status(409).json({
        error: 'type_conflict',
        message: 'Тип изменить нельзя: ' + problems.join('; ') +
          '. Сначала измените или разорвите эти подключения.',
        problems,
      });
    }
  }

  // Смена помещения без явных координат.
  //
  // Координаты иконки отсчитываются от плана конкретного этажа, поэтому
  // при переезде они теряют смысл: на другом этаже это будет случайная
  // точка, а то и вовсе за пределами плана. Обнуляем - при следующем
  // открытии карты приложение разместит устройство в новом кабинете
  // автоматически. Перетаскивание мышью присылает координаты явно,
  // поэтому под это правило не подпадает.
  const roomChanged = data.room_id !== undefined
    && Number(data.room_id) !== Number(row.room_id);

  if (roomChanged && data.pos_x === undefined && data.pos_y === undefined) {
    data.pos_x = null;
    data.pos_y = null;
  }

  // Подключение, потерявшее смысл после переезда.
  //
  // Розетка привинчена к стене конкретного кабинета: если оборудование
  // из него уехало, связь с ней - заведомо неверная запись. С другим
  // устройством сложнее: кабель через стену в соседний кабинет
  // встречается сплошь и рядом (тот же PoE-коммутатор в коридоре
  // кормит камеры по кабинетам), а вот через этаж - почти наверняка
  // ошибка. Поэтому рвём связь с розеткой при любой смене кабинета,
  // а с устройством - только при переезде на другой этаж.
  let detachedReason = null;
  if (roomChanged && req.body.uplink === undefined) {
    const target = model.uplinkTargetPlace(row);
    const newFloor = data.room_id
      ? db.prepare('SELECT floor_id FROM rooms WHERE id = ?').get(data.room_id)?.floor_id
      : null;

    if (target?.kind === 'socket' && Number(target.room_id) !== Number(data.room_id)) {
      detachedReason = `розетка ${target.label} осталась в прежнем кабинете`;
    } else if (target?.kind === 'device' && target.floor_id !== newFloor) {
      detachedReason = `${target.label} находится на другом этаже`;
    }

    if (detachedReason) {
      Object.assign(data, model.uplinkColumns({ kind: 'none' }, null));
    }
  }

  let medium;
  if (req.body.uplink !== undefined) {
    // Если тип меняется тем же запросом, связь проверяется уже по новому
    const check = model.validateConnection(row.id, req.body.uplink || { kind: 'none' },
      { asType: data.type });
    if (!check.ok) return res.status(409).json({ error: 'invalid_connection', message: check.message });
    medium = check.medium;
    Object.assign(data, model.uplinkColumns(req.body.uplink || { kind: 'none' }, medium));

    // Потомки должны остаться совместимыми и после смены типа
    if (data.type && data.type !== row.type) {
      const problems = model.validateTypeChange(row.id, data.type)
        .filter((p) => p.includes('подключено оборудование'));
      if (problems.length) {
        return res.status(409).json({ error: 'type_conflict', message: 'Тип изменить нельзя: ' + problems.join('; ') });
      }
    }
  }

  db.transaction(() => {
    update('devices', row.id, data);
    if (req.body.uplink !== undefined) {
      syncPortStatus({ kind: 'socket', id: row.uplink_socket_id });   // освободили старую
      syncPortStatus(req.body.uplink);                                 // заняли новую
    }
  })();

  const summary = describeChange(row, data);
  if (summary) logChange(req, 'device', row.id, 'update', summary);
  res.json({
    device: model.getDevice(row.id, true),
    chain: model.buildChain(row.id),
    detached: detachedReason,
  });
});

/** Короткое человекочитаемое описание правки - для журнала. */
function describeChange(before, data) {
  const parts = [];
  if (data.room_id !== undefined && data.room_id !== before.room_id) {
    const room = data.room_id
      ? db.prepare('SELECT room_number FROM rooms WHERE id = ?').get(data.room_id)
      : null;
    parts.push(room ? `перемещено в ${room.room_number}` : 'снято с помещения');
  }
  if (data.uplink_socket_id !== undefined || data.uplink_device_id !== undefined) {
    parts.push('изменено подключение');
  }
  if (data.status && data.status !== before.status) {
    parts.push(`состояние: ${cat.DEVICE_STATUSES[data.status]?.label || data.status}`);
  }
  return parts.join(', ') || null;
}

// ---------------------------------------------------------------------
//  Проверка подключения без применения - для модального окна,
//  которое всплывает при отпускании иконки на карте.
// ---------------------------------------------------------------------
router.post('/:id/check-connection', (req, res) => {
  const row = db.prepare('SELECT id FROM devices WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, 'Устройство');
  const check = model.validateConnection(row.id, req.body?.uplink || { kind: 'none' });
  res.json(check);
});

// ---------------------------------------------------------------------
//  Удаление. Подключённое снизу оборудование не пропадает -
//  просто теряет восходящую связь и остаётся в учёте.
// ---------------------------------------------------------------------
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, 'Устройство');

  const orphans = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE uplink_device_id = ?')
    .get(row.id).n;

  db.transaction(() => {
    db.prepare('UPDATE devices SET uplink_device_id = NULL, uplink_medium = NULL WHERE uplink_device_id = ?')
      .run(row.id);
    db.prepare('DELETE FROM devices WHERE id = ?').run(row.id);
    syncPortStatus({ kind: 'socket', id: row.uplink_socket_id });
  })();

  logChange(req, 'device', row.id, 'delete',
    `${cat.DEVICE_TYPES[row.type]?.label || row.type} ${row.inventory_number || ''}`.trim());
  res.json({ ok: true, detached: orphans });
});

module.exports = router;
