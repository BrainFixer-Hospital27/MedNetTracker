'use strict';
const express = require('express');
const { db, logChange } = require('../db');
const { pick, update, insert, notFound, badRequest } = require('../crud');
const model = require('../model');

const router = express.Router();

// =====================================================================
//  Розетки
// =====================================================================

const SOCKET_FIELDS = ['room_id', 'cisco_port_id', 'label', 'pos_x', 'pos_y', 'notes'];

const SOCKET_SELECT = `
  SELECT s.*, r.room_number, r.floor_id, r.department_id,
         p.port_number, p.status AS port_status, p.vlan,
         sw.id AS switch_id, sw.name AS switch_name,
         (SELECT COUNT(*) FROM devices d WHERE d.uplink_socket_id = s.id) AS devices_count
  FROM sockets s
  JOIN rooms r ON r.id = s.room_id
  LEFT JOIN cisco_ports p     ON p.id = s.cisco_port_id
  LEFT JOIN cisco_switches sw ON sw.id = p.switch_id
`;

router.get('/sockets', (req, res) => {
  const where = [];
  const args = [];
  if (req.query.room_id)  { where.push('s.room_id = ?');  args.push(req.query.room_id); }
  if (req.query.floor_id) { where.push('r.floor_id = ?'); args.push(req.query.floor_id); }
  if (req.query.free === 'yes') where.push('s.cisco_port_id IS NULL');

  const sockets = db.prepare(`${SOCKET_SELECT}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CAST(r.room_number AS INTEGER), s.label`).all(...args);
  res.json({ sockets });
});

router.post('/sockets', (req, res) => {
  const data = pick(req.body, SOCKET_FIELDS);
  if (!data.room_id || !data.label) return badRequest(res, 'Укажите помещение и обозначение розетки');
  try {
    const id = insert('sockets', data);
    logChange(req, 'socket', id, 'create', data.label);
    res.status(201).json({ socket: db.prepare(`${SOCKET_SELECT} WHERE s.id = ?`).get(id) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'port_busy', message: 'Этот порт Cisco уже занят другой розеткой' });
    }
    throw err;
  }
});

router.patch('/sockets/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM sockets WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, 'Розетка');
  try {
    update('sockets', row.id, pick(req.body, SOCKET_FIELDS));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'port_busy', message: 'Этот порт Cisco уже занят другой розеткой' });
    }
    throw err;
  }
  model.syncPortStatus({ kind: 'socket', id: row.id });
  logChange(req, 'socket', row.id, 'update', row.label);
  res.json({ socket: db.prepare(`${SOCKET_SELECT} WHERE s.id = ?`).get(row.id) });
});

router.delete('/sockets/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM sockets WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, 'Розетка');
  const used = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE uplink_socket_id = ?').get(row.id).n;
  if (used) {
    return res.status(409).json({
      error: 'not_empty',
      message: `В розетку включено устройств: ${used}. Сначала отключите их.`,
    });
  }
  db.prepare('DELETE FROM sockets WHERE id = ?').run(row.id);
  if (row.cisco_port_id) {
    db.prepare(`UPDATE cisco_ports SET status = 'free' WHERE id = ? AND status = 'active'`)
      .run(row.cisco_port_id);
  }
  logChange(req, 'socket', row.id, 'delete', row.label);
  res.json({ ok: true });
});

/** Переключение розетки на другой порт Cisco (или отвязка). */
router.patch('/sockets/:id/connect-port', (req, res) => {
  const row = db.prepare('SELECT * FROM sockets WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, 'Розетка');

  const portId = req.body?.cisco_port_id ?? null;
  if (portId) {
    const port = db.prepare('SELECT * FROM cisco_ports WHERE id = ?').get(portId);
    if (!port) return badRequest(res, 'Порт не найден');
    const busy = db.prepare('SELECT id, label FROM sockets WHERE cisco_port_id = ? AND id <> ?')
      .get(portId, row.id);
    if (busy) {
      return res.status(409).json({
        error: 'port_busy',
        message: `Порт уже закреплён за розеткой ${busy.label}`,
      });
    }
  }

  const oldPort = row.cisco_port_id;
  db.transaction(() => {
    db.prepare('UPDATE sockets SET cisco_port_id = ? WHERE id = ?').run(portId, row.id);
    if (oldPort) {
      db.prepare(`UPDATE cisco_ports SET status = 'free' WHERE id = ? AND status = 'active'`).run(oldPort);
    }
    model.syncPortStatus({ kind: 'socket', id: row.id });
  })();

  logChange(req, 'socket', row.id, 'connect', portId ? `порт #${portId}` : 'отвязана от порта');
  res.json({ socket: db.prepare(`${SOCKET_SELECT} WHERE s.id = ?`).get(row.id) });
});

// =====================================================================
//  Коммутаторы Cisco
// =====================================================================

const SWITCH_FIELDS = ['name', 'model', 'ip_address', 'total_ports', 'location', 'notes', 'sort_order'];

router.get('/cisco/switches', (req, res) => {
  const switches = db.prepare('SELECT * FROM cisco_switches ORDER BY sort_order, name').all();
  const ports = db.prepare(`
    SELECT p.*, s.id AS socket_id, s.label AS socket_label,
           r.id AS room_id, r.room_number, r.floor_id,
           f.floor_number, f.building_id, b.short_name AS building_short,
           dep.name AS department_name, dep.color AS department_color,
           (SELECT COUNT(*) FROM devices d WHERE d.uplink_socket_id = s.id) AS devices_count
    FROM cisco_ports p
    LEFT JOIN sockets s   ON s.cisco_port_id = p.id
    LEFT JOIN rooms r     ON r.id = s.room_id
    LEFT JOIN floors f    ON f.id = r.floor_id
    LEFT JOIN buildings b ON b.id = f.building_id
    LEFT JOIN departments dep ON dep.id = r.department_id
    ORDER BY p.switch_id, p.port_number
  `).all();

  for (const sw of switches) {
    sw.ports = ports.filter((p) => p.switch_id === sw.id);
    sw.used = sw.ports.filter((p) => p.status === 'active').length;
    sw.free = sw.ports.filter((p) => p.status === 'free').length;
  }
  res.json({ switches });
});

router.post('/cisco/switches', (req, res) => {
  const data = pick(req.body, SWITCH_FIELDS);
  if (!data.name) return badRequest(res, 'Укажите название коммутатора');
  const total = Number(data.total_ports) || 24;
  data.total_ports = total;

  const id = db.transaction(() => {
    const swId = insert('cisco_switches', data);
    const addPort = db.prepare('INSERT INTO cisco_ports (switch_id, port_number) VALUES (?, ?)');
    for (let i = 1; i <= total; i += 1) addPort.run(swId, i);
    return swId;
  })();

  logChange(req, 'cisco_switch', id, 'create', data.name);
  res.status(201).json({ switch: db.prepare('SELECT * FROM cisco_switches WHERE id = ?').get(id) });
});

router.patch('/cisco/switches/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM cisco_switches WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, 'Коммутатор');
  const data = pick(req.body, SWITCH_FIELDS);

  // Изменение числа портов: добавляем недостающие, лишние убираем,
  // но только если они свободны и ни к чему не привязаны.
  if (data.total_ports !== undefined && Number(data.total_ports) !== row.total_ports) {
    const next = Number(data.total_ports);
    if (!Number.isInteger(next) || next < 1 || next > 96) {
      return badRequest(res, 'Число портов должно быть от 1 до 96');
    }
    const occupied = db.prepare(`
      SELECT COUNT(*) AS n FROM cisco_ports p
      LEFT JOIN sockets s ON s.cisco_port_id = p.id
      WHERE p.switch_id = ? AND p.port_number > ? AND (s.id IS NOT NULL OR p.status <> 'free')
    `).get(row.id, next).n;
    if (occupied) {
      return res.status(409).json({
        error: 'ports_in_use',
        message: `Нельзя сократить: за портами выше ${next} закреплено ${occupied} записей`,
      });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM cisco_ports WHERE switch_id = ? AND port_number > ?').run(row.id, next);
      const addPort = db.prepare(
        'INSERT OR IGNORE INTO cisco_ports (switch_id, port_number) VALUES (?, ?)'
      );
      for (let i = 1; i <= next; i += 1) addPort.run(row.id, i);
    })();
  }

  update('cisco_switches', row.id, data);
  logChange(req, 'cisco_switch', row.id, 'update', row.name);
  res.json({ switch: db.prepare('SELECT * FROM cisco_switches WHERE id = ?').get(row.id) });
});

router.delete('/cisco/switches/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM cisco_switches WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, 'Коммутатор');
  const linked = db.prepare(`
    SELECT COUNT(*) AS n FROM sockets s
    JOIN cisco_ports p ON p.id = s.cisco_port_id WHERE p.switch_id = ?
  `).get(row.id).n;
  if (linked) {
    return res.status(409).json({
      error: 'not_empty',
      message: `К портам коммутатора привязано розеток: ${linked}.`,
    });
  }
  db.prepare('DELETE FROM cisco_switches WHERE id = ?').run(row.id);
  logChange(req, 'cisco_switch', row.id, 'delete', row.name);
  res.json({ ok: true });
});

/** Правка отдельного порта: статус, VLAN, примечание. */
router.patch('/cisco/ports/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM cisco_ports WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, 'Порт');
  const data = pick(req.body, ['status', 'vlan', 'notes']);
  if (data.status && !['free', 'active', 'reserved', 'damaged'].includes(data.status)) {
    return badRequest(res, 'Недопустимый статус порта');
  }
  update('cisco_ports', row.id, data);
  logChange(req, 'cisco_port', row.id, 'update', `порт ${row.port_number}`);
  res.json({ port: db.prepare('SELECT * FROM cisco_ports WHERE id = ?').get(row.id) });
});

module.exports = router;
