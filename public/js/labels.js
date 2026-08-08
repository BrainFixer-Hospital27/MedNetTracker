/**
 * Правила формирования подписей.
 *
 * Собраны в одном месте, потому что одно и то же название помещения
 * или устройства выводится на карте, в панели осмотра, в реестре,
 * в поиске и в диалогах. Расходиться они не должны.
 */

/**
 * Название помещения.
 * Если у кабинета задано осмысленное имя - показываем его.
 * Если нет, собираем безликое «Кабинет 214»: лучше, чем голая цифра.
 */
export function roomTitle(room) {
  if (!room) return '';
  if (room.name) return room.name;
  return 'Кабинет ' + room.room_number;
}

/**
 * Подзаголовок помещения: номер и отделение.
 * Номер повторяется в подзаголовке, только если основное название -
 * собственное имя кабинета, иначе получилось бы «Кабинет 214 · 214».
 */
export function roomSubtitle(room) {
  if (!room) return '';
  const parts = [];
  if (room.name) parts.push('каб. ' + room.room_number);
  if (room.department_name) parts.push(room.department_name);
  return parts.join(' · ');
}

/** Название единицы оборудования. */
export function deviceTitle(device) {
  if (!device) return '';
  if (device.name) return device.name;
  const made = [device.manufacturer, device.model].filter(Boolean).join(' ');
  return made || device.type_label || '';
}

/** Обрезает строку до заданной длины с многоточием. */
export function shorten(text, max) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
