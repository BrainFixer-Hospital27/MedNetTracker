'use strict';
/**
 * Месячные срезы показателей.
 *
 * База хранит только текущее состояние: сколько единиц в ремонте
 * сегодня — видно, сколько было в марте — уже нет. Журнал изменений
 * этого не восстановит, потому что фиксирует правки, а не остатки.
 *
 * Поэтому раз в месяц снимается срез — небольшой набор чисел, которые
 * позже складываются в динамику. Задним числом их собрать невозможно,
 * так что накопление начинается с первого запуска этой версии.
 */
const { db } = require('./db');
const cat = require('./catalog');

/** Текущий период в виде «2026-08». */
function currentPeriod(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Собирает показатели на данный момент. */
function collectMetrics() {
  const one = (sql, ...args) => db.prepare(sql).get(...args).n;

  const byStatus = {};
  for (const key of Object.keys(cat.DEVICE_STATUSES)) {
    byStatus[key] = one('SELECT COUNT(*) AS n FROM devices WHERE status = ?', key);
  }

  const byType = {};
  for (const row of db.prepare('SELECT type, COUNT(*) AS n FROM devices GROUP BY type').all()) {
    byType[row.type] = row.n;
  }

  return {
    devices_total: one('SELECT COUNT(*) AS n FROM devices'),
    by_status: byStatus,
    by_type: byType,
    connected: one(`SELECT COUNT(*) AS n FROM devices
      WHERE uplink_socket_id IS NOT NULL OR uplink_device_id IS NOT NULL`),
    disconnected: one(`SELECT COUNT(*) AS n FROM devices
      WHERE uplink_socket_id IS NULL AND uplink_device_id IS NULL`),
    with_mac: one(`SELECT COUNT(*) AS n FROM devices
      WHERE mac_address IS NOT NULL AND mac_address <> ''`),
    rooms: one('SELECT COUNT(*) AS n FROM rooms'),
    departments: one('SELECT COUNT(*) AS n FROM departments'),
    sockets: one('SELECT COUNT(*) AS n FROM sockets'),
    sockets_linked: one('SELECT COUNT(*) AS n FROM sockets WHERE cisco_port_id IS NOT NULL'),
    ports_total: one('SELECT COUNT(*) AS n FROM cisco_ports'),
    ports_active: one(`SELECT COUNT(*) AS n FROM cisco_ports WHERE status = 'active'`),
    ports_free: one(`SELECT COUNT(*) AS n FROM cisco_ports WHERE status = 'free'`),
    ports_damaged: one(`SELECT COUNT(*) AS n FROM cisco_ports WHERE status = 'damaged'`),
  };
}

/**
 * Снимает срез за период. По умолчанию — за текущий месяц и только
 * если его ещё нет: повторный запуск сервера в том же месяце ничего
 * не перезаписывает.
 * @param {object} options { force } — перезаписать существующий срез
 */
function capture(options = {}) {
  const period = options.period || currentPeriod();
  const existing = db.prepare('SELECT id FROM metric_snapshots WHERE period = ?').get(period);
  if (existing && !options.force) return { period, created: false };

  const data = JSON.stringify(collectMetrics());
  if (existing) {
    db.prepare(`UPDATE metric_snapshots SET data = ?, taken_at = datetime('now') WHERE id = ?`)
      .run(data, existing.id);
  } else {
    db.prepare('INSERT INTO metric_snapshots (period, data) VALUES (?, ?)').run(period, data);
  }
  return { period, created: !existing, updated: !!existing };
}

/** Все срезы по возрастанию периода. */
function listSnapshots() {
  return db.prepare('SELECT period, taken_at, data FROM metric_snapshots ORDER BY period')
    .all()
    .map((row) => {
      let data = {};
      try { data = JSON.parse(row.data); } catch { /* повреждённая запись */ }
      return { period: row.period, taken_at: row.taken_at, ...data };
    });
}

/**
 * Динамика в виде таблицы: строка на месяц.
 * Типы оборудования разворачиваются в отдельные столбцы, но только те,
 * что реально встречались, — иначе таблица зарастает пустыми колонками.
 */
function snapshotTable() {
  const snapshots = listSnapshots();

  const usedTypes = new Set();
  for (const snapshot of snapshots) {
    for (const [type, count] of Object.entries(snapshot.by_type || {})) {
      if (count) usedTypes.add(type);
    }
  }

  const columns = [
    { key: 'period', title: 'Месяц' },
    { key: 'devices_total', title: 'Оборудования всего', type: 'integer' },
    { key: 'in_use', title: 'В работе', type: 'integer' },
    { key: 'spare', title: 'В резерве', type: 'integer' },
    { key: 'repair', title: 'В ремонте', type: 'integer' },
    { key: 'written_off', title: 'Списано', type: 'integer' },
    { key: 'connected', title: 'Подключено', type: 'integer' },
    { key: 'disconnected', title: 'Без подключения', type: 'integer' },
    { key: 'sockets', title: 'Розеток', type: 'integer' },
    { key: 'sockets_linked', title: 'Розеток на Cisco', type: 'integer' },
    { key: 'ports_active', title: 'Портов занято', type: 'integer' },
    { key: 'ports_free', title: 'Портов свободно', type: 'integer' },
    { key: 'ports_damaged', title: 'Портов повреждено', type: 'integer' },
    { key: 'rooms', title: 'Помещений', type: 'integer' },
    ...[...usedTypes].map((type) => ({
      key: 'type_' + type,
      title: cat.DEVICE_TYPES[type]?.label || type,
      type: 'integer',
    })),
    { key: 'taken_at', title: 'Срез снят' },
  ];

  const rows = snapshots.map((snapshot) => {
    const row = {
      period: snapshot.period,
      devices_total: snapshot.devices_total,
      connected: snapshot.connected,
      disconnected: snapshot.disconnected,
      sockets: snapshot.sockets,
      sockets_linked: snapshot.sockets_linked,
      ports_active: snapshot.ports_active,
      ports_free: snapshot.ports_free,
      ports_damaged: snapshot.ports_damaged,
      rooms: snapshot.rooms,
      taken_at: snapshot.taken_at,
    };
    for (const [key, value] of Object.entries(snapshot.by_status || {})) row[key] = value;
    for (const type of usedTypes) row['type_' + type] = (snapshot.by_type || {})[type] || 0;
    return row;
  });

  return { columns, rows };
}

module.exports = { capture, currentPeriod, listSnapshots, snapshotTable, collectMetrics };
