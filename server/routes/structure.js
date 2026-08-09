'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, logChange, SVG_DIR } = require('../db');
const { pick, update, insert, notFound } = require('../crud');
const { parseRoomId, buildRoomId, checkPlacement } = require('../roomid');

const router = express.Router();

// =====================================================================
//  Корпуса и этажи
// =====================================================================

router.get('/buildings', (req, res) => {
  const buildings = db.prepare('SELECT * FROM buildings ORDER BY sort_order, name').all();
  const floors = db.prepare(`
    SELECT f.*, (SELECT COUNT(*) FROM rooms r WHERE r.floor_id = f.id) AS rooms_count
    FROM floors f ORDER BY f.building_id, f.floor_number
  `).all();
  for (const b of buildings) b.floors = floors.filter((f) => f.building_id === b.id);
  res.json({ buildings });
});

router.post('/buildings', (req, res) => {
  const data = pick(req.body, ['name', 'short_name', 'address', 'sort_order']);
  if (!data.name) return res.status(400).json({ error: 'bad_request', message: 'Укажите название корпуса' });
  const id = insert('buildings', data);
  logChange(req, 'building', id, 'create', data.name);
  res.status(201).json({ building: db.prepare('SELECT * FROM buildings WHERE id = ?').get(id) });
});

router.patch('/buildings/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM buildings WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, 'Корпус');
  update('buildings', row.id, pick(req.body, ['name', 'short_name', 'address', 'sort_order']));
  logChange(req, 'building', row.id, 'update', row.name);
  res.json({ building: db.prepare('SELECT * FROM buildings WHERE id = ?').get(row.id) });
});

router.delete('/buildings/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM buildings WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, 'Корпус');
  const rooms = db.prepare(`
    SELECT COUNT(*) AS n FROM rooms r JOIN floors f ON f.id = r.floor_id WHERE f.building_id = ?
  `).get(row.id).n;
  if (rooms) {
    return res.status(409).json({
      error: 'not_empty',
      message: `В корпусе ${rooms} помещений. Сначала удалите или перенесите их.`,
    });
  }
  db.prepare('DELETE FROM buildings WHERE id = ?').run(row.id);
  logChange(req, 'building', row.id, 'delete', row.name);
  res.json({ ok: true });
});

router.post('/floors', (req, res) => {
  const data = pick(req.body, ['building_id', 'floor_number', 'name']);
  if (!data.building_id || data.floor_number === undefined) {
    return res.status(400).json({ error: 'bad_request', message: 'Укажите корпус и номер этажа' });
  }
  try {
    const id = insert('floors', data);
    logChange(req, 'floor', id, 'create', `этаж ${data.floor_number}`);
    res.status(201).json({ floor: db.prepare('SELECT * FROM floors WHERE id = ?').get(id) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'duplicate', message: 'Такой этаж в корпусе уже есть' });
    }
    throw err;
  }
});

router.patch('/floors/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM floors WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, 'Этаж');
  update('floors', row.id, pick(req.body, ['building_id', 'floor_number', 'name']));
  res.json({ floor: db.prepare('SELECT * FROM floors WHERE id = ?').get(row.id) });
});

router.delete('/floors/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM floors WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, 'Этаж');
  const rooms = db.prepare('SELECT COUNT(*) AS n FROM rooms WHERE floor_id = ?').get(row.id).n;
  if (rooms) {
    return res.status(409).json({ error: 'not_empty', message: `На этаже ${rooms} помещений.` });
  }
  db.prepare('DELETE FROM floors WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// =====================================================================
//  План этажа: файл SVG
// =====================================================================

/** Отдаёт файл плана. Единственный маршрут, который может кешироваться. */
router.get('/floors/:id/svg', (req, res) => {
  const floor = db.prepare('SELECT * FROM floors WHERE id = ?').get(req.params.id);
  if (!floor || !floor.svg_file) return notFound(res, 'План этажа');
  const file = path.join(SVG_DIR, path.basename(floor.svg_file));
  if (!fs.existsSync(file)) return notFound(res, 'Файл плана');
  res.type('image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(fs.readFileSync(file, 'utf8'));
});

/**
 * Приём нового плана. Клиент присылает уже нормализованный текст SVG
 * (разбор делает встроенный в браузер DOMParser) плюс размеры холста.
 * Сервер сверяет содержимое, сохраняет файл и пробует привязать
 * полигоны к помещениям автоматически - по номеру в id.
 */
router.put('/floors/:id/svg', (req, res) => {
  const floor = db.prepare('SELECT * FROM floors WHERE id = ?').get(req.params.id);
  if (!floor) return notFound(res, 'Этаж');

  const { svg, width, height } = req.body || {};
  if (typeof svg !== 'string' || !svg.includes('<svg')) {
    return res.status(400).json({ error: 'bad_svg', message: 'Файл не похож на SVG' });
  }

  const ids = extractRoomIds(svg);
  if (!ids.length) {
    return res.status(400).json({
      error: 'no_rooms',
      message: 'В файле не найдено ни одной фигуры с id вида room-XXX. Проверьте, что при сохранении в Inkscape выключено сокращение идентификаторов.',
    });
  }

  const fileName = `floor-${floor.id}.svg`;
  fs.writeFileSync(path.join(SVG_DIR, fileName), svg, 'utf8');
  db.prepare(`UPDATE floors SET svg_file = ?, svg_width = ?, svg_height = ?,
              svg_updated_at = datetime('now') WHERE id = ?`)
    .run(fileName, width || null, height || null, floor.id);

  const report = autoBind(floor.id, ids);
  // Если в идентификаторах указаны корпус и этаж, сверяем их с тем,
  // куда файл загружают: так ловится копия чужого плана
  const warning = checkPlacement(ids, floor.building_id, floor.floor_number);

  logChange(req, 'floor', floor.id, 'update',
    `загружен план, привязано помещений: ${report.bound.length}`);
  res.json({ ok: true, warning, ...report });
});

/**
 * Вытаскивает идентификаторы помещений из текста SVG.
 * Берём все id подряд и отсеиваем те, что не похожи на помещение, -
 * так поддерживаются обе формы записи разом.
 */
function extractRoomIds(svg) {
  const found = new Set();
  const re = /\bid\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(svg)) !== null) {
    if (parseRoomId(m[1])) found.add(m[1]);
  }
  return [...found];
}

/**
 * Автопривязка. Из id 'room-53' берётся хвост '53' и ищется помещение
 * этажа с таким номером. Совпало - связали. Не совпало - в отчёт.
 */
function autoBind(floorId, svgIds) {
  const rooms = db.prepare('SELECT * FROM rooms WHERE floor_id = ?').all(floorId);
  const byNumber = new Map(rooms.map((r) => [String(r.room_number).trim().toLowerCase(), r]));

  const bound = [];
  const unmatched = [];
  const setBinding = db.prepare('UPDATE rooms SET svg_polygon_id = ? WHERE id = ?');
  const clearOthers = db.prepare(
    'UPDATE rooms SET svg_polygon_id = NULL WHERE floor_id = ? AND svg_polygon_id = ? AND id <> ?'
  );

  db.transaction(() => {
    for (const svgId of svgIds) {
      const key = String(parseRoomId(svgId)?.number || '').trim().toLowerCase();
      const room = byNumber.get(key);
      if (room) {
        clearOthers.run(floorId, svgId, room.id);
        setBinding.run(svgId, room.id);
        bound.push({ svg_polygon_id: svgId, room_id: room.id, room_number: room.room_number });
      } else {
        unmatched.push({ svg_polygon_id: svgId, suggested_number: key });
      }
    }
  })();

  const missing = db.prepare(
    'SELECT id, room_number, name FROM rooms WHERE floor_id = ? AND svg_polygon_id IS NULL ORDER BY room_number'
  ).all(floorId);

  return { bound, unmatched, missing, total_in_svg: svgIds.length };
}

/** Текущее состояние привязок этажа - для экрана администратора. */
router.get('/floors/:id/bindings', (req, res) => {
  const floor = db.prepare('SELECT * FROM floors WHERE id = ?').get(req.params.id);
  if (!floor) return notFound(res, 'Этаж');
  if (!floor.svg_file) return res.json({ bound: [], unmatched: [], missing: [], total_in_svg: 0 });

  const file = path.join(SVG_DIR, path.basename(floor.svg_file));
  const svg = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const ids = extractRoomIds(svg);

  const rooms = db.prepare('SELECT id, room_number, name, svg_polygon_id FROM rooms WHERE floor_id = ?')
    .all(floor.id);
  const usedIds = new Set(rooms.map((r) => r.svg_polygon_id).filter(Boolean));

  res.json({
    // Готовый образец идентификатора для этого этажа: чтобы при
    // обводке плана не вспоминать порядок частей
    id_hint: buildRoomId(floor.building_id, floor.floor_number, '214'),
    id_hint_corridor: buildRoomId(floor.building_id, floor.floor_number, 'kor-1'),
    total_in_svg: ids.length,
    bound: rooms.filter((r) => r.svg_polygon_id),
    unmatched: ids.filter((i) => !usedIds.has(i))
      .map((i) => ({ svg_polygon_id: i, suggested_number: parseRoomId(i)?.number || i })),
    missing: rooms.filter((r) => !r.svg_polygon_id),
  });
});

/**
 * Сброс расстановки оборудования на этаже.
 *
 * Координаты иконок отсчитываются от плана. Если план перерисовали в
 * другом масштабе или сместили, прежние координаты указывают не туда -
 * оборудование окажется в углу или за пределами помещений. Обнуляем их,
 * и при следующем открытии карты приложение разложит всё заново по
 * фактическим границам кабинетов.
 */
router.post('/floors/:id/reset-positions', (req, res) => {
  const floor = db.prepare('SELECT * FROM floors WHERE id = ?').get(req.params.id);
  if (!floor) return notFound(res, 'Этаж');

  const result = db.transaction(() => {
    const devices = db.prepare(`
      UPDATE devices SET pos_x = NULL, pos_y = NULL
      WHERE room_id IN (SELECT id FROM rooms WHERE floor_id = ?)
    `).run(floor.id).changes;
    const sockets = db.prepare(`
      UPDATE sockets SET pos_x = NULL, pos_y = NULL
      WHERE room_id IN (SELECT id FROM rooms WHERE floor_id = ?)
    `).run(floor.id).changes;
    return { devices, sockets };
  })();

  logChange(req, 'floor', floor.id, 'update',
    `сброшена расстановка: ${result.devices} устройств, ${result.sockets} розеток`);
  res.json(result);
});

/** Ручная привязка одного полигона к помещению. */
router.post('/floors/:id/bindings', (req, res) => {
  const floor = db.prepare('SELECT * FROM floors WHERE id = ?').get(req.params.id);
  if (!floor) return notFound(res, 'Этаж');
  const { svg_polygon_id: polygonId, room_id: roomId } = req.body || {};
  if (!polygonId) return res.status(400).json({ error: 'bad_request', message: 'Не указан полигон' });

  db.transaction(() => {
    db.prepare('UPDATE rooms SET svg_polygon_id = NULL WHERE floor_id = ? AND svg_polygon_id = ?')
      .run(floor.id, polygonId);
    if (roomId) db.prepare('UPDATE rooms SET svg_polygon_id = ? WHERE id = ?').run(polygonId, roomId);
  })();

  logChange(req, 'floor', floor.id, 'update', `привязка ${polygonId}`);
  res.json({ ok: true });
});

/** Создаёт помещения для полигонов, которым не нашлось пары. */
router.post('/floors/:id/rooms-from-svg', (req, res) => {
  const floor = db.prepare('SELECT * FROM floors WHERE id = ?').get(req.params.id);
  if (!floor) return notFound(res, 'Этаж');
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const created = [];

  db.transaction(() => {
    for (const item of items) {
      const polygonId = item.svg_polygon_id;
      const number = String(item.room_number ?? polygonId.replace(/^room-/, '')).trim();
      if (!polygonId || !number) continue;
      const exists = db.prepare('SELECT id FROM rooms WHERE floor_id = ? AND room_number = ?')
        .get(floor.id, number);
      if (exists) {
        db.prepare('UPDATE rooms SET svg_polygon_id = ? WHERE id = ?').run(polygonId, exists.id);
        created.push({ room_id: exists.id, room_number: number, reused: true });
        continue;
      }
      const id = insert('rooms', {
        floor_id: floor.id,
        room_number: number,
        department_id: item.department_id || null,
        name: item.name || null,
        svg_polygon_id: polygonId,
      });
      created.push({ room_id: id, room_number: number, reused: false });
    }
  })();

  logChange(req, 'floor', floor.id, 'create', `помещений из плана: ${created.length}`);
  res.json({ created });
});

// =====================================================================
//  Отделения
// =====================================================================

router.get('/departments', (req, res) => {
  const departments = db.prepare(`
    SELECT d.*,
      (SELECT COUNT(*) FROM rooms r WHERE r.department_id = d.id) AS rooms_count,
      (SELECT COUNT(*) FROM devices dv JOIN rooms r ON r.id = dv.room_id
        WHERE r.department_id = d.id) AS devices_count
    FROM departments d ORDER BY d.name
  `).all();
  res.json({ departments });
});

const DEPT_FIELDS = ['name', 'head_person', 'phone', 'color', 'notes'];

router.post('/departments', (req, res) => {
  const data = pick(req.body, DEPT_FIELDS);
  if (!data.name) return res.status(400).json({ error: 'bad_request', message: 'Укажите название отделения' });
  try {
    const id = insert('departments', data);
    logChange(req, 'department', id, 'create', data.name);
    res.status(201).json({ department: db.prepare('SELECT * FROM departments WHERE id = ?').get(id) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'duplicate', message: 'Отделение с таким названием уже есть' });
    }
    throw err;
  }
});

router.patch('/departments/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM departments WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, 'Отделение');
  update('departments', row.id, pick(req.body, DEPT_FIELDS));
  logChange(req, 'department', row.id, 'update', row.name);
  res.json({ department: db.prepare('SELECT * FROM departments WHERE id = ?').get(row.id) });
});

router.delete('/departments/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM departments WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, 'Отделение');
  // Помещения не удаляем - просто остаются без отделения (ON DELETE SET NULL)
  db.prepare('DELETE FROM departments WHERE id = ?').run(row.id);
  logChange(req, 'department', row.id, 'delete', row.name);
  res.json({ ok: true });
});

// =====================================================================
//  Помещения
// =====================================================================

const ROOM_FIELDS = ['floor_id', 'department_id', 'room_number', 'name', 'svg_polygon_id', 'area', 'notes'];

router.get('/rooms', (req, res) => {
  const where = [];
  const args = [];
  if (req.query.floor_id) { where.push('r.floor_id = ?'); args.push(req.query.floor_id); }
  if (req.query.department_id) { where.push('r.department_id = ?'); args.push(req.query.department_id); }
  if (req.query.building_id) { where.push('f.building_id = ?'); args.push(req.query.building_id); }

  const rooms = db.prepare(`
    SELECT r.*, f.floor_number, f.building_id, b.name AS building_name,
           d.name AS department_name, d.color AS department_color,
           (SELECT COUNT(*) FROM devices dv WHERE dv.room_id = r.id) AS devices_count,
           (SELECT COUNT(*) FROM sockets s WHERE s.room_id = r.id) AS sockets_count
    FROM rooms r
    JOIN floors f    ON f.id = r.floor_id
    JOIN buildings b ON b.id = f.building_id
    LEFT JOIN departments d ON d.id = r.department_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY b.sort_order, f.floor_number, CAST(r.room_number AS INTEGER), r.room_number
  `).all(...args);
  res.json({ rooms });
});

router.post('/rooms', (req, res) => {
  const data = pick(req.body, ROOM_FIELDS);
  if (!data.floor_id || !data.room_number) {
    return res.status(400).json({ error: 'bad_request', message: 'Укажите этаж и номер помещения' });
  }
  try {
    const id = insert('rooms', data);
    logChange(req, 'room', id, 'create', `помещение ${data.room_number}`);
    res.status(201).json({ room: db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'duplicate', message: 'Такой номер на этаже уже занят' });
    }
    throw err;
  }
});

router.patch('/rooms/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, 'Помещение');
  update('rooms', row.id, pick(req.body, ROOM_FIELDS));
  logChange(req, 'room', row.id, 'update', `помещение ${row.room_number}`);
  res.json({ room: db.prepare('SELECT * FROM rooms WHERE id = ?').get(row.id) });
});

router.delete('/rooms/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, 'Помещение');
  const devices = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE room_id = ?').get(row.id).n;
  const sockets = db.prepare('SELECT COUNT(*) AS n FROM sockets WHERE room_id = ?').get(row.id).n;
  if (devices || sockets) {
    return res.status(409).json({
      error: 'not_empty',
      message: `В помещении ${devices} устройств и ${sockets} розеток. Сначала перенесите их.`,
    });
  }
  db.prepare('DELETE FROM rooms WHERE id = ?').run(row.id);
  logChange(req, 'room', row.id, 'delete', `помещение ${row.room_number}`);
  res.json({ ok: true });
});

module.exports = router;
