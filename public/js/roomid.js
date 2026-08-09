/**
 * Разбор идентификаторов фигур на плане этажа.
 * Зеркало серверного модуля server/roomid.js — правила должны
 * совпадать, иначе клиент и сервер разойдутся в том, что считать
 * помещением.
 *
 *   room-214      короткая форма
 *   b1-f2-r214    полная: корпус, этаж, помещение
 */

const SHORT = /^room-(.+)$/;
const FULL = /^b(\d+)-f(\d+)-r-?(.+)$/;

export function parseRoomId(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();

  const full = FULL.exec(trimmed);
  if (full) return { number: full[3], building: Number(full[1]), floor: Number(full[2]) };

  const short = SHORT.exec(trimmed);
  if (short) return { number: short[1], building: null, floor: null };

  return null;
}

export function isRoomId(id) {
  return parseRoomId(id) !== null;
}

/**
 * Находит в документе все фигуры помещений.
 * Селектором это не выразить: querySelectorAll не умеет регулярных
 * выражений, поэтому перебираем всё с атрибутом id и отсеиваем лишнее.
 */
export function findRoomShapes(root) {
  return [...root.querySelectorAll('[id]')].filter((el) => isRoomId(el.id));
}
