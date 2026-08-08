'use strict';
/**
 * Наполнение базы демонстрационными данными.
 *
 *   npm run seed          - создать демо-данные (если база пуста)
 *   npm run seed -- --force  - стереть всё содержимое и создать заново
 *
 * Планы этажей генерируются программно в том же формате, который
 * ожидается от Inkscape: коридор посередине, помещения по сторонам,
 * у каждого фигура с id="room-XXX".
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { db, migrate, SVG_DIR } = require('../server/db');

const force = process.argv.includes('--force');

// =====================================================================
//  Генератор поэтажного плана
// =====================================================================

/**
 * Рисует коридорный этаж. Единица SVG = 1 см.
 * @param {object} opts
 * @param {number[]} opts.top    ширины помещений верхнего ряда, см
 * @param {number[]} opts.bottom ширины помещений нижнего ряда, см
 * @param {string[]} opts.topNumbers    номера помещений верхнего ряда
 * @param {string[]} opts.bottomNumbers номера помещений нижнего ряда
 */
function makeFloorPlan({ top, bottom, topNumbers, bottomNumbers, corridorNumber }) {
  const DEPTH_TOP = 520;
  const DEPTH_BOTTOM = 560;
  const CORRIDOR = 240;
  const MARGIN = 40;

  const widthTop = top.reduce((a, b) => a + b, 0);
  const widthBottom = bottom.reduce((a, b) => a + b, 0);
  const inner = Math.max(widthTop, widthBottom);
  const W = inner + MARGIN * 2;
  const H = DEPTH_TOP + CORRIDOR + DEPTH_BOTTOM + MARGIN * 2;

  const yTop = MARGIN;
  const yCorridor = yTop + DEPTH_TOP;
  const yBottom = yCorridor + CORRIDOR;
  const yEnd = yBottom + DEPTH_BOTTOM;

  const rooms = [];

  const row = (widths, numbers, y0, y1) => {
    let x = MARGIN;
    widths.forEach((w, i) => {
      const num = numbers[i];
      rooms.push(
        `    <path id="room-${num}" class="room" d="M ${x} ${y0} H ${x + w} V ${y1} H ${x} Z" />`
      );
      x += w;
    });
  };

  row(top, topNumbers, yTop, yCorridor);
  row(bottom, bottomNumbers, yBottom, yEnd);

  rooms.push(
    `    <path id="room-${corridorNumber}" class="room" ` +
    `d="M ${MARGIN} ${yCorridor} H ${MARGIN + inner} V ${yBottom} H ${MARGIN} Z" />`
  );

  // Внутренние перегородки для слоя графики
  const walls = [];
  const wallRow = (widths, y0, y1) => {
    let x = MARGIN;
    for (const w of widths) {
      x += w;
      if (x < MARGIN + inner - 1) walls.push(`M ${x} ${y0} V ${y1}`);
    }
  };
  wallRow(top, yTop, yCorridor);
  wallRow(bottom, yBottom, yEnd);

  return {
    width: W,
    height: H,
    svg: `<?xml version="1.0" encoding="UTF-8"?>
<!-- Демонстрационный план. Единица SVG = 1 см. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">

  <g id="layer-base" pointer-events="none" fill="none"
     stroke="#38414d" stroke-width="16" stroke-linejoin="miter">
    <path d="M ${MARGIN} ${yTop} H ${MARGIN + inner} V ${yEnd} H ${MARGIN} Z" />
    <path d="M ${MARGIN} ${yCorridor} H ${MARGIN + inner}" stroke-width="12" />
    <path d="M ${MARGIN} ${yBottom} H ${MARGIN + inner}" stroke-width="12" />
    <path d="${walls.join(' ')}" stroke-width="10" />
  </g>

  <g id="layer-rooms">
${rooms.join('\n')}
  </g>
</svg>
`,
  };
}

/** Раскладывает ширины помещений так, чтобы ряд выглядел естественно. */
function widths(count, seedValue) {
  const out = [];
  let s = seedValue;
  for (let i = 0; i < count; i += 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push(320 + ((s >> 8) % 5) * 70); // от 320 до 600 см
  }
  return out;
}

// =====================================================================
//  Данные
// =====================================================================

const DEPARTMENTS = [
  ['Приёмное отделение',              'Ковалёва Т. И.', '#0969da'],
  ['Хирургическое отделение',         'Дёмин А. С.',    '#1a7f37'],
  ['ЛОР-отделение',                   'Савельев П. Н.', '#8250df'],
  ['Клинико-диагностическая лаборатория', 'Мирошник Е. В.', '#bf3989'],
  ['Отделение лучевой диагностики',   'Титов Р. Г.',    '#cf222e'],
  ['Физиотерапия',                    'Ганина Л. Ф.',   '#1f883d'],
  ['Бухгалтерия',                     'Шевцова И. А.',  '#bf8700'],
  ['Отдел кадров',                    'Панин В. В.',    '#a55b00'],
  ['Администрация',                   'Ерохин С. М.',   '#4a5568'],
  ['Аптека',                          'Лапина О. Д.',   '#0e7c86'],
  ['Хозяйственная служба',            'Бойко Н. Т.',    '#57606a'],
  ['Отдел информатизации',            'Зуев К. А.',     '#218bff'],
];

const FIRMS = {
  pc:      [['Depo', 'Neos 220'], ['HP', 'ProDesk 400 G7'], ['Lenovo', 'ThinkCentre M70q'], ['Крафтвэй', 'Credo VV22']],
  aio:     [['Lenovo', 'IdeaCentre AIO 3'], ['HP', 'ProOne 440 G9'], ['Acer', 'Aspire C24']],
  laptop:  [['HP', 'ProBook 450 G8'], ['Lenovo', 'ThinkPad E15'], ['ASUS', 'ExpertBook B1']],
  net_printer: [['HP', 'LaserJet Pro M404dn'], ['Kyocera', 'ECOSYS P3145dn'], ['Brother', 'HL-L5100DN']],
  usb_printer: [['Canon', 'i-SENSYS LBP6030'], ['HP', 'LaserJet 1020'], ['Pantum', 'P2200']],
  mfp:     [['Kyocera', 'ECOSYS M2040dn'], ['HP', 'LaserJet MFP M428fdn'], ['Xerox', 'WorkCentre 3335']],
  scanner: [['Canon', 'DR-C225'], ['Epson', 'Perfection V19']],
  switch:  [['TP-Link', 'TL-SG1008D'], ['D-Link', 'DES-1008A'], ['Tenda', 'S105']],
  router:  [['Keenetic', 'Giga KN-1011'], ['TP-Link', 'Archer C6'], ['MikroTik', 'hAP ac2']],
  medical: [['Mindray', 'BC-5150'], ['Siemens', 'Somatom Scope'], ['Sysmex', 'XN-350'], ['Philips', 'Affiniti 50']],
  ip_phone: [['Grandstream', 'GXP1620'], ['Yealink', 'SIP-T31G']],
  ip_camera: [['Hikvision', 'DS-2CD2143G2'], ['Dahua', 'IPC-HDW2431T'],
              ['RVi', '1NCT2079'], ['Uniview', 'IPC3614LE']],
  poe_switch: [['TP-Link', 'TL-SG1008P'], ['Hikvision', 'DS-3E0109P-E'],
               ['Dahua', 'PFS3010-8ET-96'], ['Ubiquiti', 'USW-Lite-8-PoE']],
  nvr:       [['Hikvision', 'DS-7608NI-K2'], ['Dahua', 'NVR4208-8P']],
};

const CARTRIDGES = { 'LaserJet Pro M404dn': 'CF259A', 'ECOSYS P3145dn': 'TK-3160',
  'HL-L5100DN': 'TN-3480', 'i-SENSYS LBP6030': 'Cartridge 725', 'LaserJet 1020': 'Q2612A',
  'P2200': 'PC-211EV', 'ECOSYS M2040dn': 'TK-1170', 'LaserJet MFP M428fdn': 'CF259A',
  'WorkCentre 3335': '106R03621' };

// Названия помещений. Часть кабинетов остаётся без имени - тогда
// приложение показывает «Кабинет 214», и это тоже нормальный случай.
const ROOM_NAMES = [
  'Ординаторская', 'Кабинет заведующего', 'Манипуляционная', 'Процедурная',
  'Перевязочная', 'Смотровая', 'Сестринская', 'Регистратура', 'Кабинет УЗИ',
  'Лаборантская', 'Кабинет ЭКГ', 'Физиокабинет', 'Приёмный покой', 'Архив',
  'Серверная', 'Кабинет старшей медсестры', 'Бухгалтерия', 'Приёмная главврача',
  'Кабинет статистики', 'Аптечный склад', 'Стерилизационная', 'Кабинет ЛОР-врача',
  'Эндоскопический кабинет', 'Кабинет функциональной диагностики', 'Гардероб',
  'Комната отдыха персонала', 'Кабинет рентгенолога', 'Материальная',
];

const SURNAMES = [
  'Абрамов А. П.', 'Белова Н. С.', 'Волков Д. И.', 'Гущина М. А.', 'Дроздов Е. В.',
  'Ершова О. Л.', 'Жуков С. С.', 'Зимина Т. Р.', 'Игнатьев П. К.', 'Кириллова А. В.',
  'Лобанов Р. Н.', 'Морозова Ю. А.', 'Никитин В. Б.', 'Орехова С. Д.', 'Петров И. И.',
  'Родионова Л. М.', 'Соколов А. Ю.', 'Тарасова В. Г.', 'Уваров К. С.', 'Фомина Е. Н.',
];

// Простой воспроизводимый генератор случайных чисел: один и тот же
// seed всегда даёт одинаковую демо-базу.
let seed = 20260807;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const pickOne = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const intBetween = (a, b) => a + Math.floor(rnd() * (b - a + 1));

function macAddress() {
  const hex = () => Math.floor(rnd() * 256).toString(16).padStart(2, '0').toUpperCase();
  return ['00', '1B', hex(), hex(), hex(), hex()].join(':');
}

// =====================================================================
//  Наполнение
// =====================================================================

function clearAll() {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DELETE FROM devices; DELETE FROM sockets; DELETE FROM cisco_ports;
    DELETE FROM cisco_switches; DELETE FROM rooms; DELETE FROM floors;
    DELETE FROM buildings; DELETE FROM departments; DELETE FROM change_log;
    DELETE FROM sqlite_sequence WHERE name IN
      ('devices','sockets','cisco_ports','cisco_switches','rooms','floors','buildings','departments','change_log');
    PRAGMA foreign_keys = ON;
  `);
  for (const f of fs.readdirSync(SVG_DIR)) {
    if (/^floor-\d+\.svg$/.test(f)) fs.unlinkSync(path.join(SVG_DIR, f));
  }
}

function run() {
  migrate();

  const existing = db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n;
  if (existing > 0 && !force) {
    console.log(`В базе уже есть ${existing} помещений. Для перезаписи: npm run seed -- --force`);
    process.exit(0);
  }
  if (force) clearAll();

  const insert = (table, data) => {
    const keys = Object.keys(data);
    return db.prepare(
      `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
    ).run(...keys.map((k) => data[k])).lastInsertRowid;
  };

  // --- Отделения ---
  const deptIds = DEPARTMENTS.map(([name, head, color]) =>
    insert('departments', { name, head_person: head, color, phone: `4-${intBetween(10, 99)}` }));

  // --- Корпуса и этажи ---
  const mainId = insert('buildings', {
    name: 'Больничный корпус', short_name: 'БК', sort_order: 1,
    address: 'ул. Больничная, 1',
  });
  const labId = insert('buildings', {
    name: 'Лабораторный корпус', short_name: 'ЛК', sort_order: 2,
    address: 'ул. Больничная, 1 к2',
  });

  const plan = [
    { building: mainId, floor: 1, rooms: [9, 8] },
    { building: mainId, floor: 2, rooms: [10, 9] },
    { building: mainId, floor: 3, rooms: [8, 8] },
    { building: mainId, floor: 4, rooms: [7, 6] },
    { building: labId,  floor: 1, rooms: [6, 5] },
    { building: labId,  floor: 2, rooms: [5, 5] },
  ];

  const roomIds = [];

  for (const item of plan) {
    const floorId = insert('floors', {
      building_id: item.building, floor_number: item.floor,
      name: `${item.floor} этаж`,
    });

    const prefix = item.building === mainId ? item.floor : 5 + item.floor;
    const [topCount, bottomCount] = item.rooms;
    let n = 1;
    const topNumbers = Array.from({ length: topCount }, () => `${prefix}${String(n++).padStart(2, '0')}`);
    const bottomNumbers = Array.from({ length: bottomCount }, () => `${prefix}${String(n++).padStart(2, '0')}`);
    const corridorNumber = `kor-${prefix}`;

    const { svg, width, height } = makeFloorPlan({
      top: widths(topCount, floorId * 7919),
      bottom: widths(bottomCount, floorId * 104729),
      topNumbers, bottomNumbers, corridorNumber,
    });

    const fileName = `floor-${floorId}.svg`;
    fs.writeFileSync(path.join(SVG_DIR, fileName), svg, 'utf8');
    db.prepare(`UPDATE floors SET svg_file = ?, svg_width = ?, svg_height = ?,
                svg_updated_at = datetime('now') WHERE id = ?`)
      .run(fileName, width, height, floorId);

    // Помещения. Отделение выбирается блоками, чтобы соседние кабинеты
    // чаще принадлежали одному подразделению - как в жизни.
    let currentDept = pickOne(deptIds);
    let streak = 0;
    const usedNames = new Set();
    for (const number of [...topNumbers, ...bottomNumbers]) {
      if (streak <= 0) { currentDept = pickOne(deptIds); streak = intBetween(2, 5); }
      streak -= 1;

      // Примерно двум третям кабинетов даём осмысленное название,
      // остальные останутся «Кабинет 214» - как в жизни
      let roomName = null;
      if (chance(0.65)) {
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const candidate = pickOne(ROOM_NAMES);
          if (!usedNames.has(candidate)) { roomName = candidate; usedNames.add(candidate); break; }
        }
      }

      const id = insert('rooms', {
        floor_id: floorId, department_id: currentDept, room_number: number,
        name: roomName,
        svg_polygon_id: `room-${number}`, area: intBetween(120, 380) / 10,
      });
      roomIds.push({ id, number, floorId });
    }
    // Коридор - без отделения
    insert('rooms', {
      floor_id: floorId, room_number: corridorNumber, name: 'Коридор',
      svg_polygon_id: `room-${corridorNumber}`,
    });
  }

  // --- Коммутаторы Cisco ---
  const switchIds = [];
  for (let i = 1; i <= 5; i += 1) {
    const id = insert('cisco_switches', {
      name: `SW-${String(i).padStart(2, '0')}`,
      model: 'Cisco Catalyst 2960-24TC-L',
      ip_address: `10.0.0.${10 + i}`,
      total_ports: 24, location: 'Серверная, стойка 1', sort_order: i,
    });
    for (let p = 1; p <= 24; p += 1) insert('cisco_ports', { switch_id: id, port_number: p });
    switchIds.push(id);
  }
  const allPorts = db.prepare('SELECT * FROM cisco_ports ORDER BY switch_id, port_number').all();
  let portCursor = 0;

  // --- Розетки, оборудование ---
  const socketsByRoom = new Map();

  for (const room of roomIds) {
    const count = chance(0.15) ? intBetween(4, 6) : intBetween(1, 3);
    const list = [];
    for (let i = 1; i <= count; i += 1) {
      // Часть розеток намеренно оставляем без порта Cisco -
      // разрывы цепочки допустимы по пункту 1.3 задания.
      const port = chance(0.85) && portCursor < allPorts.length ? allPorts[portCursor++] : null;
      const id = insert('sockets', {
        room_id: room.id,
        cisco_port_id: port ? port.id : null,
        label: `${room.number}/${i}`,
      });
      list.push({ id, port });
    }
    socketsByRoom.set(room.id, list);
  }

  const addDevice = (data) => insert('devices', data);
  let invCounter = 41001;
  const inv = () => `ОС-${invCounter++}`;

  for (const room of roomIds) {
    const sockets = socketsByRoom.get(room.id) || [];
    if (!sockets.length) continue;

    const workplaces = Math.min(intBetween(1, 4), 4);
    let socketCursor = 0;
    const nextSocket = () => (socketCursor < sockets.length ? sockets[socketCursor++] : null);

    // Если рабочих мест больше, чем розеток, ставим неуправляемый свитч
    let hubId = null;
    if (workplaces > sockets.length) {
      const [mf, md] = pickOne(FIRMS.switch);
      const sock = nextSocket();
      hubId = addDevice({
        room_id: room.id, type: 'switch', manufacturer: mf, model: md,
        inventory_number: inv(), serial_number: `SW${intBetween(10000, 99999)}`,
        ports_count: pickOne([5, 8]), status: 'in_use',
        uplink_socket_id: sock ? sock.id : null,
        uplink_medium: sock ? 'ethernet' : null,
        responsible_person: pickOne(SURNAMES),
      });
    }

    for (let w = 0; w < workplaces; w += 1) {
      const type = chance(0.2) ? 'aio' : chance(0.12) ? 'laptop' : 'pc';
      const [mf, md] = pickOne(FIRMS[type]);
      const sock = hubId ? null : nextSocket();
      const person = pickOne(SURNAMES);

      const pcId = addDevice({
        room_id: room.id, type, manufacturer: mf, model: md,
        inventory_number: inv(),
        serial_number: `${md.slice(0, 3).toUpperCase()}${intBetween(100000, 999999)}`,
        mac_address: macAddress(), responsible_person: person,
        status: chance(0.06) ? 'repair' : 'in_use',
        uplink_socket_id: sock ? sock.id : null,
        uplink_device_id: hubId,
        uplink_medium: sock || hubId ? 'ethernet' : null,
      });

      // Локальный принтер по USB
      if (chance(0.3)) {
        const ptype = chance(0.5) ? 'usb_printer' : 'scanner';
        const [pmf, pmd] = pickOne(FIRMS[ptype]);
        addDevice({
          room_id: room.id, type: ptype, manufacturer: pmf, model: pmd,
          inventory_number: inv(), serial_number: `P${intBetween(100000, 999999)}`,
          responsible_person: person, uplink_device_id: pcId, uplink_medium: 'usb',
          cartridge_model: CARTRIDGES[pmd] || null,
        });
      }
    }

    // Сетевая печать
    if (chance(0.35)) {
      const ptype = chance(0.5) ? 'mfp' : 'net_printer';
      const [pmf, pmd] = pickOne(FIRMS[ptype]);
      const sock = nextSocket();
      addDevice({
        room_id: room.id, type: ptype, manufacturer: pmf, model: pmd,
        inventory_number: inv(), serial_number: `N${intBetween(100000, 999999)}`,
        mac_address: macAddress(), responsible_person: pickOne(SURNAMES),
        uplink_socket_id: sock ? sock.id : hubId ? null : null,
        uplink_device_id: sock ? null : hubId,
        uplink_medium: sock || hubId ? 'ethernet' : null,
        cartridge_model: CARTRIDGES[pmd] || null,
      });
    }

    // Точка доступа Wi-Fi
    let routerId = null;
    if (chance(0.12)) {
      const [rmf, rmd] = pickOne(FIRMS.router);
      const sock = nextSocket();
      routerId = addDevice({
        room_id: room.id, type: 'router', manufacturer: rmf, model: rmd,
        inventory_number: inv(), serial_number: `R${intBetween(100000, 999999)}`,
        mac_address: macAddress(), ports_count: 4,
        router_login: 'admin', router_password: `Rt${intBetween(1000, 9999)}!x`,
        wifi_ssid: `HOSP-${room.number}`, wifi_password: `wifi${intBetween(100000, 999999)}`,
        responsible_person: 'Зуев К. А.',
        uplink_socket_id: sock ? sock.id : null,
        uplink_medium: sock ? 'ethernet' : null,
        notes: 'Изолированный сегмент для мобильных устройств',
      });
    }

    // Что-нибудь подключённое к точке доступа по воздуху: иначе
    // беспроводная среда нигде в демо-данных не встретится
    // По воздуху подключаются только ноутбуки: камеры видеонаблюдения
    // в этой системе исключительно проводные
    if (routerId) {
      const wireless = 'laptop';
      const [wmf, wmd] = pickOne(FIRMS[wireless]);
      addDevice({
        room_id: room.id, type: wireless, manufacturer: wmf, model: wmd,
        inventory_number: inv(), serial_number: `W${intBetween(100000, 999999)}`,
        mac_address: macAddress(), responsible_person: pickOne(SURNAMES),
        uplink_device_id: routerId, uplink_medium: 'wifi',
      });
    }

    // Медицинское оборудование
    if (chance(0.08)) {
      const [mmf, mmd] = pickOne(FIRMS.medical);
      const sock = nextSocket();
      addDevice({
        room_id: room.id, type: 'medical', manufacturer: mmf, model: mmd,
        inventory_number: inv(), serial_number: `MED${intBetween(10000, 99999)}`,
        mac_address: macAddress(), responsible_person: pickOne(SURNAMES),
        uplink_socket_id: sock ? sock.id : null,
        uplink_medium: sock ? 'ethernet' : null,
        notes: 'Подключение согласовано с сервисной службой поставщика',
      });
    }
  }

  // -------------------------------------------------------------------
  //  Видеонаблюдение.
  //  Схема как в жизни: на этаже стоит PoE-коммутатор, обычно в
  //  коридоре или подсобке, от него расходятся камеры по коридорам и
  //  входам. Питание идёт по тому же кабелю, поэтому розетка нужна
  //  только самому коммутатору.
  // -------------------------------------------------------------------
  const floors = db.prepare('SELECT id FROM floors ORDER BY id').all();
  let nvrId = null;

  for (const floor of floors) {
    const floorRooms = roomIds.filter((r) => r.floorId === floor.id);
    if (!floorRooms.length) continue;

    const corridor = db.prepare(
      `SELECT id, room_number FROM rooms WHERE floor_id = ? AND room_number LIKE 'kor-%'`
    ).get(floor.id);
    const hostRoom = corridor || floorRooms[0];

    // Регистратор ставится один на всё здание, в первой же серверной
    if (!nvrId) {
      const [nmf, nmd] = pickOne(FIRMS.nvr);
      const uplinkSocket = socketsByRoom.get(floorRooms[0].id)?.find((s) => s.port);
      nvrId = addDevice({
        room_id: floorRooms[0].id, type: 'nvr', manufacturer: nmf, model: nmd,
        inventory_number: inv(), serial_number: `NVR${intBetween(10000, 99999)}`,
        mac_address: macAddress(), ports_count: 8,
        responsible_person: 'Зуев К. А.',
        uplink_socket_id: uplinkSocket ? uplinkSocket.id : null,
        uplink_medium: uplinkSocket ? 'ethernet' : null,
        notes: 'Архив видеонаблюдения, глубина хранения 30 суток',
      });
    }

    const [pmf, pmd] = pickOne(FIRMS.poe_switch);
    const ports = pickOne([8, 8, 16]);

    // Коммутатор включается в свободную розетку своего этажа: у коридора
    // своей розетки обычно нет, поэтому берём ближайшую в кабинетах.
    // К регистратору напрямую тянут редко - оставим такой вариант для
    // одного этажа, чтобы в демо-данных встретился и он.
    const usedByPoe = new Set(
      db.prepare(`SELECT uplink_socket_id AS id FROM devices
                  WHERE type = 'poe_switch' AND uplink_socket_id IS NOT NULL`)
        .all().map((x) => x.id)
    );
    let sock = null;
    for (const room of [hostRoom, ...floorRooms]) {
      const candidate = (socketsByRoom.get(room.id) || [])
        .find((s) => s.port && !usedByPoe.has(s.id));
      if (candidate) { sock = candidate; break; }
    }
    const viaNvr = (!sock || floor.id === floors[floors.length - 1].id) && nvrId;
    if (viaNvr) sock = null;
    const poeId = addDevice({
      room_id: hostRoom.id, type: 'poe_switch', manufacturer: pmf, model: pmd,
      inventory_number: inv(), serial_number: `POE${intBetween(10000, 99999)}`,
      mac_address: macAddress(), ports_count: ports,
      poe_budget: ports === 8 ? 65 : 130,
      responsible_person: 'Зуев К. А.',
      uplink_socket_id: sock ? sock.id : null,
      uplink_device_id: viaNvr ? nvrId : null,
      uplink_medium: sock || viaNvr ? 'ethernet' : null,
      notes: 'Питание камер этажа по PoE',
    });

    // Камеры: часть в коридоре, часть по кабинетам
    const cameraCount = intBetween(3, Math.min(ports - 1, 6));
    for (let i = 0; i < cameraCount; i += 1) {
      const [cmf, cmd] = pickOne(FIRMS.ip_camera);
      const place = i < 2 ? hostRoom : pickOne(floorRooms);
      addDevice({
        room_id: place.id, type: 'ip_camera', manufacturer: cmf, model: cmd,
        inventory_number: inv(), serial_number: `CAM${intBetween(100000, 999999)}`,
        mac_address: macAddress(),
        ip_address: `10.20.${floor.id}.${10 + i}`,
        responsible_person: 'Зуев К. А.',
        uplink_device_id: poeId, uplink_medium: 'ethernet',
        notes: i < 2 ? 'Обзор коридора' : null,
      });
    }
  }

  // Одна камера подключена напрямую в розетку - так тоже бывает,
  // когда PoE-инжектор стоит рядом с самой камерой
  const directRoom = roomIds[0];
  const directSocket = socketsByRoom.get(directRoom.id)?.slice(-1)[0];
  if (directSocket) {
    const [cmf, cmd] = pickOne(FIRMS.ip_camera);
    addDevice({
      room_id: directRoom.id, type: 'ip_camera', manufacturer: cmf, model: cmd,
      inventory_number: inv(), serial_number: `CAM${intBetween(100000, 999999)}`,
      mac_address: macAddress(), responsible_person: 'Зуев К. А.',
      uplink_socket_id: directSocket.id, uplink_medium: 'ethernet',
      notes: 'Питание от локального PoE-инжектора',
    });
  }

  // Пара единиц на складе - без помещения и без подключения
  for (let i = 0; i < 4; i += 1) {
    const [mf, md] = pickOne(FIRMS.pc);
    addDevice({
      room_id: null, type: 'pc', manufacturer: mf, model: md,
      inventory_number: inv(), serial_number: `SPR${intBetween(100000, 999999)}`,
      status: 'spare', notes: 'Резерв, склад отдела информатизации',
    });
  }

  // Статусы портов приводим в соответствие с подключениями
  db.exec(`
    UPDATE cisco_ports SET status = 'active' WHERE id IN (
      SELECT s.cisco_port_id FROM sockets s
      JOIN devices d ON d.uplink_socket_id = s.id
      WHERE s.cisco_port_id IS NOT NULL
    );
  `);
  // Несколько повреждённых портов для наглядности
  db.exec(`
    UPDATE cisco_ports SET status = 'damaged', notes = 'Не проходит тест линии'
    WHERE status = 'free' AND id IN (SELECT id FROM cisco_ports WHERE status = 'free' LIMIT 3);
  `);

  const stat = (sql) => db.prepare(sql).get().n;
  console.log('');
  console.log('  Демонстрационные данные созданы');
  console.log(`  корпусов ........ ${stat('SELECT COUNT(*) n FROM buildings')}`);
  console.log(`  этажей .......... ${stat('SELECT COUNT(*) n FROM floors')}`);
  console.log(`  отделений ....... ${stat('SELECT COUNT(*) n FROM departments')}`);
  console.log(`  помещений ....... ${stat('SELECT COUNT(*) n FROM rooms')}`);
  console.log(`  розеток ......... ${stat('SELECT COUNT(*) n FROM sockets')}`);
  console.log(`  оборудования .... ${stat('SELECT COUNT(*) n FROM devices')}`);
  console.log(`  портов Cisco .... ${stat('SELECT COUNT(*) n FROM cisco_ports')}`);
  console.log(`  камер ........... ${stat("SELECT COUNT(*) n FROM devices WHERE type = 'ip_camera'")}`);
  console.log(`  PoE-свитчей ..... ${stat("SELECT COUNT(*) n FROM devices WHERE type = 'poe_switch'")}`);
  console.log('');
  console.log('  Иконки на карте пока не расставлены: координаты появятся');
  console.log('  после первого автоматического размещения в интерфейсе.');
  console.log('');
}

run();
