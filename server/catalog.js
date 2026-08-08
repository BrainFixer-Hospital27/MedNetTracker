'use strict';
/**
 * Справочник предметной области.
 *
 * Это единственное место, где описано, какие бывают типы оборудования,
 * что во что можно воткнуть и какие поля показывать в карточке.
 * Сервер проверяет по нему входящие данные, клиент получает его целиком
 * через GET /api/meta и строит из него формы, слои карты и правила
 * Drag-and-Drop. Добавили тип здесь - он появился везде.
 */

// --- Слои карты. Порядок задаёт порядок переключателей в интерфейсе. ---
const LAYERS = [
  { key: 'sockets',   label: 'Розетки',      color: '#6b7a8f' },
  { key: 'computers', label: 'Компьютеры',   color: '#1f6feb' },
  { key: 'printers',  label: 'Печать',       color: '#8250df' },
  { key: 'network',   label: 'Коммутация',   color: '#bf8700' },
  { key: 'medical',   label: 'Медтехника',   color: '#cf222e' },
  { key: 'video',     label: 'Видеонаблюдение', color: '#2f855a' },
  { key: 'other',     label: 'Прочее',       color: '#57606a' },
];

// --- Среды передачи ---
const MEDIA = {
  ethernet: { label: 'Ethernet', line: 'solid' },
  wifi:     { label: 'Wi-Fi',    line: 'dotted' },
  usb:      { label: 'USB',      line: 'dashed' },
};

/**
 * Типы оборудования.
 *   layer        - слой карты
 *   uplink       - какими средами устройство может подключаться "вверх"
 *   accepts      - какие среды устройство принимает "снизу"; пусто = конечное
 *   fields       - дополнительные поля карточки сверх общих
 *   icon         - имя фигуры, отрисовываемой на карте
 */
const DEVICE_TYPES = {
  pc: {
    label: 'Системный блок', short: 'ПК', layer: 'computers', icon: 'pc',
    uplink: ['ethernet', 'wifi'], accepts: ['usb'],
  },
  aio: {
    label: 'Моноблок', short: 'Моноблок', layer: 'computers', icon: 'pc',
    uplink: ['ethernet', 'wifi'], accepts: ['usb'],
  },
  laptop: {
    label: 'Ноутбук', short: 'Ноутбук', layer: 'computers', icon: 'laptop',
    uplink: ['ethernet', 'wifi'], accepts: ['usb'],
  },
  thin_client: {
    label: 'Тонкий клиент', short: 'Тонкий кл.', layer: 'computers', icon: 'pc',
    uplink: ['ethernet'], accepts: ['usb'],
  },
  net_printer: {
    label: 'Сетевой принтер', short: 'Принтер', layer: 'printers', icon: 'printer',
    uplink: ['ethernet', 'wifi'], accepts: [],
    fields: ['cartridge_model'],
  },
  usb_printer: {
    label: 'Принтер USB', short: 'Принтер USB', layer: 'printers', icon: 'printer',
    uplink: ['usb'], accepts: [],
    fields: ['cartridge_model'],
  },
  mfp: {
    label: 'МФУ', short: 'МФУ', layer: 'printers', icon: 'mfp',
    uplink: ['ethernet', 'usb', 'wifi'], accepts: [],
    fields: ['cartridge_model'],
  },
  scanner: {
    label: 'Сканер', short: 'Сканер', layer: 'printers', icon: 'scanner',
    uplink: ['usb'], accepts: [],
  },
  switch: {
    label: 'Неуправляемый коммутатор', short: 'Свитч', layer: 'network', icon: 'switch',
    uplink: ['ethernet'], accepts: ['ethernet'],
    fields: ['ports_count'],
  },
  router: {
    label: 'Роутер / точка доступа', short: 'Роутер', layer: 'network', icon: 'router',
    uplink: ['ethernet'], accepts: ['ethernet', 'wifi'],
    fields: ['ports_count', 'router_login', 'router_password', 'wifi_ssid', 'wifi_password'],
  },
  poe_switch: {
    label: 'PoE-коммутатор', short: 'PoE-свитч', layer: 'network', icon: 'poe_switch',
    uplink: ['ethernet'], accepts: ['ethernet'],
    fields: ['ports_count', 'poe_budget'],
  },
  medical: {
    label: 'Медицинское оборудование', short: 'Медтехника', layer: 'medical', icon: 'medical',
    uplink: ['ethernet'], accepts: [],
  },
  ip_phone: {
    label: 'IP-телефон', short: 'IP-тел.', layer: 'other', icon: 'phone',
    uplink: ['ethernet'], accepts: ['ethernet'],
  },
  ip_camera: {
    // Камеры видеонаблюдения подключаются исключительно по кабелю -
    // чаще всего к своему PoE-коммутатору, но допустимо и напрямую
    // в розетку либо в промежуточный коммутатор.
    label: 'IP-камера', short: 'Камера', layer: 'video', icon: 'camera',
    uplink: ['ethernet'], accepts: [],
  },
  nvr: {
    label: 'Видеорегистратор', short: 'Регистратор', layer: 'video', icon: 'nvr',
    uplink: ['ethernet'], accepts: ['ethernet'],
    fields: ['ports_count'],
  },
  other: {
    label: 'Прочее оборудование', short: 'Прочее', layer: 'other', icon: 'other',
    uplink: ['ethernet', 'usb', 'wifi'], accepts: [],
  },
};

// --- Состояния ---
const DEVICE_STATUSES = {
  in_use:      { label: 'В работе',   color: '#1a7f37' },
  spare:       { label: 'В резерве',  color: '#6b7a8f' },
  repair:      { label: 'В ремонте',  color: '#bf8700' },
  written_off: { label: 'Списано',    color: '#cf222e' },
};

const PORT_STATUSES = {
  free:     { label: 'Свободен',  color: '#8b95a5' },
  active:   { label: 'Занят',     color: '#1a7f37' },
  reserved: { label: 'Резерв',    color: '#0969da' },
  damaged:  { label: 'Повреждён', color: '#cf222e' },
};

// --- Описание общих полей карточки (подписи и подсказки для форм) ---
const FIELD_LABELS = {
  name:               'Название',
  manufacturer:       'Производитель',
  model:              'Модель',
  serial_number:      'Серийный номер',
  inventory_number:   'Инвентарный номер',
  mac_address:        'MAC-адрес',
  ip_address:         'IP-адрес',
  responsible_person: 'Ответственный',
  notes:              'Примечание',
  ports_count:        'Число портов',
  poe_budget:         'Бюджет PoE, Вт',
  router_login:       'Логин админ-панели',
  router_password:    'Пароль админ-панели',
  wifi_ssid:          'Имя сети Wi-Fi',
  wifi_password:      'Пароль Wi-Fi',
  cartridge_model:    'Модель картриджа',
};

// Поля, которые не отдаются в списках - только в карточке одного устройства
const SECRET_FIELDS = ['router_password', 'wifi_password'];

// =====================================================================
//  Правила соединений
// =====================================================================

/** Может ли устройство типа `type` подключаться средой `medium` вверх. */
function canUplink(type, medium) {
  const t = DEVICE_TYPES[type];
  return !!t && t.uplink.includes(medium);
}

/** Принимает ли устройство типа `type` подключение средой `medium`. */
function canAccept(type, medium) {
  const t = DEVICE_TYPES[type];
  return !!t && (t.accepts || []).includes(medium);
}

// Порядок перебора сред. Задаёт предпочтение: если пара соединима
// и кабелем, и по воздуху, по умолчанию предполагаем кабель.
const MEDIA_ORDER = ['ethernet', 'usb', 'wifi'];

/**
 * Все среды, которыми ребёнок может подключиться к родителю.
 * Пара бывает совместима сразу несколькими способами: ноутбук к
 * роутеру подключается и патч-кордом, и по Wi-Fi, и выбор между ними -
 * решение администратора, а не системы.
 */
function validMedia(childType, parentType) {
  return MEDIA_ORDER.filter(
    (medium) => canUplink(childType, medium) && canAccept(parentType, medium)
  );
}

/**
 * Предпочтительная среда для соединения ребёнок -> родитель.
 * Возвращает null, если пара несовместима вовсе.
 */
function resolveMedium(childType, parentType) {
  return validMedia(childType, parentType)[0] || null;
}

/** Может ли устройство типа `type` втыкаться в сетевую розетку. */
function canPlugIntoSocket(type) {
  return canUplink(type, 'ethernet');
}

/** Человекочитаемая причина отказа - для подсказки в интерфейсе. */
function explainRejection(childType, parentType) {
  const c = DEVICE_TYPES[childType];
  const p = DEVICE_TYPES[parentType];
  if (!c || !p) return 'Неизвестный тип оборудования';
  if (!p.accepts || p.accepts.length === 0) {
    return `${p.label} - конечное устройство, к нему нельзя ничего подключить`;
  }
  return `${c.label} нельзя подключить к «${p.label}»: нет общей среды передачи`;
}

module.exports = {
  LAYERS, MEDIA, DEVICE_TYPES, DEVICE_STATUSES, PORT_STATUSES,
  FIELD_LABELS, SECRET_FIELDS,
  canUplink, canAccept, validMedia, resolveMedium, canPlugIntoSocket, explainRejection,
};
