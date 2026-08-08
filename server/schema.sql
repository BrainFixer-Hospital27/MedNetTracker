-- =====================================================================
--  MedNet Tracker  |  схема базы данных
--  SQLite 3. Один файл: data/database.sqlite
-- =====================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
--  Учётная запись администратора
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- Сессии express-session, чтобы вход переживал перезапуск сервера
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ---------------------------------------------------------------------
--  Физическая иерархия: корпус -> этаж -> помещение
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS buildings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  short_name TEXT,
  address    TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS floors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  building_id  INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  floor_number INTEGER NOT NULL,
  name         TEXT,
  -- имя файла внутри data/svg. NULL - план ещё не загружен
  svg_file      TEXT,
  svg_width     REAL,
  svg_height    REAL,
  svg_updated_at TEXT,
  UNIQUE (building_id, floor_number)
);

CREATE TABLE IF NOT EXISTS departments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  head_person TEXT,
  phone       TEXT,
  -- цвет подсветки помещений на карте, #rrggbb
  color       TEXT    NOT NULL DEFAULT '#8b95a5',
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS rooms (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_id        INTEGER NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
  department_id   INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  room_number     TEXT    NOT NULL,
  name            TEXT,
  -- id тега полигона в SVG-файле этажа, например 'room-53'
  svg_polygon_id  TEXT,
  area            REAL,
  notes           TEXT,
  UNIQUE (floor_id, room_number)
);
CREATE INDEX IF NOT EXISTS idx_rooms_floor ON rooms(floor_id);
CREATE INDEX IF NOT EXISTS idx_rooms_dept  ON rooms(department_id);

-- ---------------------------------------------------------------------
--  Магистральный уровень: коммутаторы Cisco в серверной
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cisco_switches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  model       TEXT,
  ip_address  TEXT,
  total_ports INTEGER NOT NULL DEFAULT 24,
  location    TEXT,
  notes       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cisco_ports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  switch_id   INTEGER NOT NULL REFERENCES cisco_switches(id) ON DELETE CASCADE,
  port_number INTEGER NOT NULL,
  -- free | active | damaged | reserved
  status      TEXT    NOT NULL DEFAULT 'free',
  vlan        TEXT,
  notes       TEXT,
  UNIQUE (switch_id, port_number)
);

-- ---------------------------------------------------------------------
--  Розетки. Один порт Cisco обслуживает не более одной розетки
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sockets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id       INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  cisco_port_id INTEGER UNIQUE REFERENCES cisco_ports(id) ON DELETE SET NULL,
  label         TEXT    NOT NULL,
  pos_x         REAL,
  pos_y         REAL,
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sockets_room ON sockets(room_id);

-- ---------------------------------------------------------------------
--  Оборудование. Одна таблица на всё: ПК, принтеры, свитчи, роутеры,
--  медтехника и USB-периферия. Тип устройства решает, какие поля
--  осмысленны и что к нему можно подключить (см. server/catalog.js).
--
--  Восходящая связь ("во что воткнуто") намеренно разложена на две
--  колонки вместо одной полиморфной: так SQLite сам следит за
--  целостностью через внешние ключи. Наружу, в API, они склеиваются
--  обратно в объект uplink = { kind, id, medium }.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id          INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  type             TEXT    NOT NULL,
  name             TEXT,

  manufacturer     TEXT,
  model            TEXT,
  serial_number    TEXT,
  inventory_number TEXT,
  mac_address      TEXT,
  ip_address       TEXT,
  responsible_person TEXT,
  -- in_use | spare | repair | written_off
  status           TEXT    NOT NULL DEFAULT 'in_use',
  notes            TEXT,

  -- положение иконки в координатах SVG этажа
  pos_x            REAL,
  pos_y            REAL,

  -- восходящая связь
  uplink_socket_id INTEGER REFERENCES sockets(id) ON DELETE SET NULL,
  uplink_device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  -- ethernet | usb | wifi
  uplink_medium    TEXT,

  -- поля, осмысленные лишь для части типов
  ports_count      INTEGER,        -- свитчи, роутеры, PoE-коммутаторы
  poe_budget       INTEGER,        -- бюджет питания PoE-коммутатора, Вт
  router_login     TEXT,           -- роутеры: доступ в админ-панель
  router_password  TEXT,
  wifi_ssid        TEXT,
  wifi_password    TEXT,
  cartridge_model  TEXT,           -- печатающая техника

  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),

  -- воткнуть можно либо в розетку, либо в другое устройство, но не в оба
  CHECK (uplink_socket_id IS NULL OR uplink_device_id IS NULL),
  -- устройство не может быть подключено само к себе
  CHECK (uplink_device_id IS NULL OR uplink_device_id <> id)
);
CREATE INDEX IF NOT EXISTS idx_devices_room   ON devices(room_id);
CREATE INDEX IF NOT EXISTS idx_devices_type   ON devices(type);
CREATE INDEX IF NOT EXISTS idx_devices_socket ON devices(uplink_socket_id);
CREATE INDEX IF NOT EXISTS idx_devices_parent ON devices(uplink_device_id);
CREATE INDEX IF NOT EXISTS idx_devices_inv    ON devices(inventory_number);
CREATE INDEX IF NOT EXISTS idx_devices_mac    ON devices(mac_address);

-- Отметка времени правки обновляется сама
CREATE TRIGGER IF NOT EXISTS trg_devices_touch
AFTER UPDATE ON devices
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE devices SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ---------------------------------------------------------------------
--  Месячные срезы показателей.
--  База хранит текущее состояние, а вопрос «сколько было в марте»
--  задают регулярно. Раз в месяц сюда складывается набор чисел -
--  задним числом его собрать невозможно.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metric_snapshots (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  period   TEXT NOT NULL UNIQUE,   -- 'ГГГГ-ММ'
  taken_at TEXT NOT NULL DEFAULT (datetime('now')),
  data     TEXT NOT NULL           -- показатели в JSON
);

-- ---------------------------------------------------------------------
--  Журнал изменений: кто и что правил. Пишется автоматически на
--  каждом изменяющем запросе, читается на вкладке "История".
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS change_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  username    TEXT,
  entity      TEXT NOT NULL,   -- device | socket | room | ...
  entity_id   INTEGER,
  action      TEXT NOT NULL,   -- create | update | delete | move | connect
  summary     TEXT
);
CREATE INDEX IF NOT EXISTS idx_changelog_at ON change_log(at DESC);
