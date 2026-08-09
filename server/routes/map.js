'use strict';
const express = require('express');
const { db } = require('../db');
const cat = require('../catalog');
const model = require('../model');

const router = express.Router();

// =====================================================================
//  Справочник предметной области. Клиент забирает его один раз при
//  запуске и строит из него формы, слои и правила перетаскивания.
// =====================================================================
router.get('/meta', (req, res) => {
  res.json({
    layers: cat.LAYERS,
    media: cat.MEDIA,
    device_types: cat.DEVICE_TYPES,
    device_statuses: cat.DEVICE_STATUSES,
    port_statuses: cat.PORT_STATUSES,
    field_labels: cat.FIELD_LABELS,
  });
});

// =====================================================================
//  Всё содержимое одного этажа одним запросом.
//  Линии связи клиент строит сам: у него на руках и розетки,
//  и устройства с их координатами.
// =====================================================================
router.get('/map', (req, res) => {
  const floorId = req.query.floor_id;
  if (!floorId) return res.status(400).json({ error: 'bad_request', message: 'Не указан этаж' });

  const floor = db.prepare(`
    SELECT f.*, b.name AS building_name, b.short_name AS building_short
    FROM floors f JOIN buildings b ON b.id = f.building_id WHERE f.id = ?
  `).get(floorId);
  if (!floor) return res.status(404).json({ error: 'not_found', message: 'Этаж не найден' });

  const rooms = db.prepare(`
    SELECT r.*, d.name AS department_name, d.color AS department_color
    FROM rooms r LEFT JOIN departments d ON d.id = r.department_id
    WHERE r.floor_id = ?
  `).all(floorId);

  const sockets = db.prepare(`
    SELECT s.*, r.floor_id, p.port_number, p.status AS port_status,
           sw.name AS switch_name,
           (SELECT COUNT(*) FROM devices d WHERE d.uplink_socket_id = s.id) AS devices_count
    FROM sockets s
    JOIN rooms r ON r.id = s.room_id
    LEFT JOIN cisco_ports p     ON p.id = s.cisco_port_id
    LEFT JOIN cisco_switches sw ON sw.id = p.switch_id
    WHERE r.floor_id = ?
  `).all(floorId);

  const devices = db.prepare(`
    SELECT d.*, r.floor_id FROM devices d JOIN rooms r ON r.id = d.room_id
    WHERE r.floor_id = ?
  `).all(floorId).map((d) => {
    const out = model.serializeDevice(d);
    out.floor_id = d.floor_id;
    return out;
  });

  res.json({ floor, rooms, sockets, devices });
});

/**
 * Пакетное сохранение координат.
 *
 * Нужно для авторазмещения: геометрию помещений знает только браузер,
 * которому SVG уже разобран, поэтому раскладку по кабинетам считает
 * клиент, а сюда присылает готовый список точек одним запросом.
 * Тело: { devices: [{id, pos_x, pos_y}], sockets: [{id, pos_x, pos_y}] }
 */
router.patch('/positions', (req, res) => {
  const devices = Array.isArray(req.body?.devices) ? req.body.devices : [];
  const sockets = Array.isArray(req.body?.sockets) ? req.body.sockets : [];

  const setDevice = db.prepare('UPDATE devices SET pos_x = ?, pos_y = ? WHERE id = ?');
  const setSocket = db.prepare('UPDATE sockets SET pos_x = ?, pos_y = ? WHERE id = ?');

  const applied = db.transaction(() => {
    let n = 0;
    for (const d of devices) {
      if (!d || d.id == null) continue;
      setDevice.run(num(d.pos_x), num(d.pos_y), d.id); n += 1;
    }
    for (const s of sockets) {
      if (!s || s.id == null) continue;
      setSocket.run(num(s.pos_x), num(s.pos_y), s.id); n += 1;
    }
    return n;
  })();

  res.json({ ok: true, applied });
});

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Содержимое всех этажей сразу - для режима «всё здание».
 *
 * Планы SVG сюда намеренно не включены: с вшитой растровой подложкой
 * они весят мегабайты, и тянуть их все ради одного запроса расточительно.
 * Клиент забирает их по мере надобности через /api/floors/:id/svg.
 */
router.get('/map/all', (req, res) => {
  const floors = db.prepare(`
    SELECT f.*, b.name AS building_name, b.short_name AS building_short,
           b.sort_order AS building_order
    FROM floors f JOIN buildings b ON b.id = f.building_id
    ORDER BY b.sort_order, b.id, f.floor_number
  `).all();

  const rooms = db.prepare(`
    SELECT r.*, d.name AS department_name, d.color AS department_color
    FROM rooms r LEFT JOIN departments d ON d.id = r.department_id
  `).all();

  const sockets = db.prepare(`
    SELECT s.*, r.floor_id, p.port_number, p.status AS port_status,
           sw.name AS switch_name,
           (SELECT COUNT(*) FROM devices d WHERE d.uplink_socket_id = s.id) AS devices_count
    FROM sockets s
    JOIN rooms r ON r.id = s.room_id
    LEFT JOIN cisco_ports p     ON p.id = s.cisco_port_id
    LEFT JOIN cisco_switches sw ON sw.id = p.switch_id
  `).all();

  const devices = db.prepare(`
    SELECT d.*, r.floor_id FROM devices d JOIN rooms r ON r.id = d.room_id
  `).all().map((d) => {
    const out = model.serializeDevice(d);
    out.floor_id = d.floor_id;
    return out;
  });

  res.json({ floors, rooms, sockets, devices });
});

/**
 * Оборудование вне помещений: склад, заказанное, запланированное.
 * Показывается отдельной полосой сбоку от карты, откуда его можно
 * перетащить на план.
 */
router.get('/map/unplaced', (req, res) => {
  const devices = db.prepare('SELECT * FROM devices WHERE room_id IS NULL ORDER BY status, type, id')
    .all().map((d) => model.serializeDevice(d));
  res.json({ devices });
});

// =====================================================================
//  Глобальный поиск. Возвращает разнородные результаты сразу с
//  координатами перехода: корпус, этаж, помещение, точка на карте.
// =====================================================================
router.get('/search', (req, res) => {
  const raw = String(req.query.q || '').trim();
  if (raw.length < 2) return res.json({ results: [] });
  const q = `%${raw.toLowerCase()}%`;
  const limit = Math.min(Number(req.query.limit) || 25, 100);

  const devices = db.prepare(`
    SELECT d.id, d.type, d.name, d.model, d.manufacturer, d.inventory_number,
           d.serial_number, d.mac_address, d.ip_address, d.responsible_person,
           d.pos_x, d.pos_y, d.room_id,
           r.room_number, r.floor_id, f.floor_number, f.building_id, b.short_name AS building_short
    FROM devices d
    LEFT JOIN rooms r     ON r.id = d.room_id
    LEFT JOIN floors f    ON f.id = r.floor_id
    LEFT JOIN buildings b ON b.id = f.building_id
    WHERE lc(IFNULL(d.inventory_number,''))   LIKE ?
       OR lc(IFNULL(d.serial_number,''))      LIKE ?
       OR lc(IFNULL(d.mac_address,''))        LIKE ?
       OR lc(IFNULL(d.ip_address,''))         LIKE ?
       OR lc(IFNULL(d.responsible_person,'')) LIKE ?
       OR lc(IFNULL(d.name,''))               LIKE ?
       OR lc(IFNULL(d.model,''))              LIKE ?
    LIMIT ?
  `).all(q, q, q, q, q, q, q, limit);

  const rooms = db.prepare(`
    SELECT r.id, r.room_number, r.name, r.floor_id, r.svg_polygon_id,
           f.floor_number, f.building_id, b.short_name AS building_short,
           dep.name AS department_name
    FROM rooms r
    JOIN floors f    ON f.id = r.floor_id
    JOIN buildings b ON b.id = f.building_id
    LEFT JOIN departments dep ON dep.id = r.department_id
    WHERE lc(r.room_number) LIKE ? OR lc(IFNULL(r.name,'')) LIKE ?
    LIMIT ?
  `).all(q, q, limit);

  const sockets = db.prepare(`
    SELECT s.id, s.label, s.pos_x, s.pos_y, s.room_id,
           r.room_number, r.floor_id, f.floor_number, f.building_id,
           b.short_name AS building_short, p.port_number, sw.name AS switch_name
    FROM sockets s
    JOIN rooms r     ON r.id = s.room_id
    JOIN floors f    ON f.id = r.floor_id
    JOIN buildings b ON b.id = f.building_id
    LEFT JOIN cisco_ports p     ON p.id = s.cisco_port_id
    LEFT JOIN cisco_switches sw ON sw.id = p.switch_id
    WHERE lc(s.label) LIKE ?
    LIMIT ?
  `).all(q, limit);

  const people = db.prepare(`
    SELECT DISTINCT responsible_person AS name FROM devices
    WHERE responsible_person IS NOT NULL AND lc(responsible_person) LIKE ?
    LIMIT 10
  `).all(q);

  const results = [
    ...devices.map((d) => ({
      kind: 'device', id: d.id,
      title: model.deviceTitle(d),
      subtitle: [cat.DEVICE_TYPES[d.type]?.label, d.inventory_number, d.mac_address]
        .filter(Boolean).join(' · '),
      place: placeLabel(d),
      goto: { building_id: d.building_id, floor_id: d.floor_id, room_id: d.room_id, device_id: d.id },
    })),
    ...rooms.map((r) => ({
      kind: 'room', id: r.id,
      title: r.name || `Кабинет ${r.room_number}`,
      subtitle: [r.name ? `каб. ${r.room_number}` : null, r.department_name]
        .filter(Boolean).join(' · '),
      place: placeLabel(r),
      goto: { building_id: r.building_id, floor_id: r.floor_id, room_id: r.id },
    })),
    ...sockets.map((s) => ({
      kind: 'socket', id: s.id,
      title: `Розетка ${s.label}`,
      subtitle: s.switch_name ? `${s.switch_name} · порт ${s.port_number}` : 'не подключена к Cisco',
      place: placeLabel(s),
      goto: { building_id: s.building_id, floor_id: s.floor_id, room_id: s.room_id, socket_id: s.id },
    })),
    ...people.map((p) => ({
      kind: 'person', id: p.name,
      title: p.name, subtitle: 'ответственный', place: null,
      goto: { query: p.name },
    })),
  ];

  res.json({ results: results.slice(0, limit), query: raw });
});

function placeLabel(row) {
  if (!row.floor_number && !row.room_number) return null;
  return [
    row.building_short,
    row.floor_number ? `${row.floor_number} эт.` : null,
    row.room_number ? `каб. ${row.room_number}` : null,
  ].filter(Boolean).join(' · ');
}

// =====================================================================
//  Сводка для стартового экрана
// =====================================================================
router.get('/stats', (req, res) => {
  const one = (sql, ...args) => db.prepare(sql).get(...args);

  const byType = db.prepare(`
    SELECT type, COUNT(*) AS n FROM devices GROUP BY type ORDER BY n DESC
  `).all().map((r) => ({ ...r, label: cat.DEVICE_TYPES[r.type]?.label || r.type }));

  res.json({
    devices: one('SELECT COUNT(*) AS n FROM devices').n,
    devices_unconnected: one(
      'SELECT COUNT(*) AS n FROM devices WHERE uplink_socket_id IS NULL AND uplink_device_id IS NULL'
    ).n,
    devices_unplaced: one(
      'SELECT COUNT(*) AS n FROM devices WHERE pos_x IS NULL OR pos_y IS NULL'
    ).n,
    rooms: one('SELECT COUNT(*) AS n FROM rooms').n,
    rooms_unmapped: one('SELECT COUNT(*) AS n FROM rooms WHERE svg_polygon_id IS NULL').n,
    sockets: one('SELECT COUNT(*) AS n FROM sockets').n,
    sockets_no_port: one('SELECT COUNT(*) AS n FROM sockets WHERE cisco_port_id IS NULL').n,
    ports_total: one('SELECT COUNT(*) AS n FROM cisco_ports').n,
    ports_active: one(`SELECT COUNT(*) AS n FROM cisco_ports WHERE status = 'active'`).n,
    ports_free: one(`SELECT COUNT(*) AS n FROM cisco_ports WHERE status = 'free'`).n,
    by_type: byType,
  });
});

// =====================================================================
//  Ревизия связей
// =====================================================================
router.get('/integrity', (req, res) => {
  const { findInvalidLinks } = require('../integrity');
  res.json({ problems: findInvalidLinks() });
});

router.post('/integrity/repair', (req, res) => {
  const { repairInvalidLinks } = require('../integrity');
  const result = repairInvalidLinks();
  res.json({ detached: result.detached, medium_fixed: result.mediumFixed });
});

// =====================================================================
//  Журнал изменений
// =====================================================================
router.get('/changelog', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const entries = db.prepare('SELECT * FROM change_log ORDER BY id DESC LIMIT ?').all(limit);
  res.json({ entries });
});

module.exports = router;
