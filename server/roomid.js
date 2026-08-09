'use strict';
/**
 * Разбор идентификаторов фигур на плане этажа.
 *
 * Поддерживаются два вида записи:
 *
 *   room-214          короткая. Внутри одного файла этого достаточно:
 *                     файл всегда относится к конкретному этажу.
 *
 *   b1-f2-r214        полная: корпус, этаж, помещение. Номера корпуса и
 *                     этажа приложением не используются для привязки,
 *                     но по ним видно, какому этажу принадлежит файл, -
 *                     и это позволяет поймать классическую ошибку, когда
 *                     план одного этажа скопировали как заготовку для
 *                     другого и забыли поправить.
 *
 * Помещениям без номера - коридорам, лестницам - дают буквенные
 * обозначения: room-kor-1, b1-f2-r-kor-1.
 */

const SHORT = /^room-(.+)$/;
const FULL = /^b(\d+)-f(\d+)-r-?(.+)$/;

/**
 * Разбирает идентификатор.
 * @returns {{number: string, building: number|null, floor: number|null}|null}
 *          null, если это не фигура помещения
 */
function parseRoomId(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();

  const full = FULL.exec(trimmed);
  if (full) {
    return { number: full[3], building: Number(full[1]), floor: Number(full[2]) };
  }

  const short = SHORT.exec(trimmed);
  if (short) {
    return { number: short[1], building: null, floor: null };
  }

  return null;
}

/** Является ли идентификатор обозначением помещения. */
function isRoomId(id) {
  return parseRoomId(id) !== null;
}

/**
 * Собирает идентификатор в полной форме - для подсказки на экране
 * загрузки, чтобы не приходилось вспоминать порядок частей.
 */
function buildRoomId(buildingId, floorNumber, roomNumber) {
  const tail = /^\d/.test(String(roomNumber)) ? roomNumber : '-' + roomNumber;
  return `b${buildingId}-f${floorNumber}-r${tail}`;
}

/**
 * Сверяет корпус и этаж, указанные в идентификаторах, с тем этажом,
 * куда файл загружают.
 * @returns {string|null} текст предупреждения либо null, если всё сходится
 */
function checkPlacement(ids, buildingId, floorNumber) {
  const parsed = ids.map(parseRoomId).filter((p) => p && p.building !== null);
  if (!parsed.length) return null;   // короткая форма, сверять нечего

  const buildings = [...new Set(parsed.map((p) => p.building))];
  const floors = [...new Set(parsed.map((p) => p.floor))];

  if (buildings.length > 1 || floors.length > 1) {
    return 'В файле смешаны идентификаторы разных этажей или корпусов: ' +
      `корпуса ${buildings.join(', ')}, этажи ${floors.join(', ')}. ` +
      'Похоже, часть фигур скопирована с другого плана.';
  }

  const [building] = buildings;
  const [floor] = floors;
  if (building !== Number(buildingId) || floor !== Number(floorNumber)) {
    return `Идентификаторы в файле помечены как корпус ${building}, этаж ${floor}, ` +
      `а загружаете вы их на корпус ${buildingId}, этаж ${floorNumber}. ` +
      'Проверьте, тот ли это файл. Привязка выполнена по номерам помещений.';
  }

  return null;
}

module.exports = { parseRoomId, isRoomId, buildRoomId, checkPlacement };
