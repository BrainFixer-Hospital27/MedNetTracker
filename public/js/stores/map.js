import { defineStore } from 'pinia';
import { ref, computed, shallowRef } from 'vue';
import { mapApi, structureApi, deviceApi, networkApi } from '../api.js';
import { useMetaStore } from './core.js';

// Отступы при раскладке этажей в общем виде, в единицах карты.
// Заданы долями от размеров блока, чтобы не зависеть от масштаба планов.
const GAP_BETWEEN_FLOORS = 0.18;
const GAP_BETWEEN_BUILDINGS = 0.14;
const LABEL_BAND = 0.09;

export const useMapStore = defineStore('map', () => {
  const meta = useMetaStore();

  // --- Режим отображения ---
  // 'floor'    — один этаж, повседневная работа
  // 'building' — все этажи всех корпусов, для переездов и обзора
  const mode = ref('floor');

  // --- Данные ---
  const floorId = ref(null);      // выбранный этаж (в обоих режимах)
  const floor = ref(null);
  const floorsMeta = ref([]);     // сведения об этажах для общего вида
  const rooms = ref([]);
  const sockets = ref([]);
  const devices = ref([]);
  const unplaced = ref([]);       // оборудование вне помещений
  // Планы этажей: грузятся по мере надобности и остаются в памяти.
  // С вшитой подложкой они весят мегабайты, тянуть их все сразу незачем.
  const svgCache = shallowRef(new Map());
  const loading = ref(false);
  const error = ref(null);

  /** План текущего этажа — для совместимости с одиночным режимом. */
  const svgText = computed(() => svgCache.value.get(floorId.value) || '');

  // --- Состояние интерфейса ---
  const selection = ref(null);       // { kind, id }
  const highlightId = ref(null);     // подсветка после перехода из поиска
  const hiddenLayers = ref(new Set());
  const showLabels = ref(true);
  const showLinks = ref(true);
  const showInspector = ref(true);   // правая панель развёрнута

  // --- Указатели ---
  const roomsById   = computed(() => new Map(rooms.value.map((r) => [r.id, r])));
  const socketsById = computed(() => new Map(sockets.value.map((s) => [s.id, s])));
  const devicesById = computed(() => new Map(devices.value.map((d) => [d.id, d])));
  // Ключ включает этаж: в разных корпусах встречаются одинаковые
  // номера, и в общем виде фигуры room-101 будут сразу с двух планов
  const roomsByPolygon = computed(() => {
    const map = new Map();
    for (const r of rooms.value) {
      if (r.svg_polygon_id) map.set(r.floor_id + ':' + r.svg_polygon_id, r);
    }
    return map;
  });

  /**
   * Блоки карты — прямоугольные области, каждая со своим планом этажа.
   *
   * В одиночном режиме блок один и лежит в начале координат; в общем
   * виде этажи раскладываются столбцами по корпусам, снизу вверх по
   * номеру. Всё остальное приложение работает с блоками одинаково, и
   * поэтому логика отрисовки и перетаскивания у режимов общая.
   */
  const blocks = computed(() => {
    const list = mode.value === 'building'
      ? floorsMeta.value
      : (floor.value ? [floor.value] : []);
    if (!list.length) return [];

    const sized = list.map((f) => ({
      floorId: f.id,
      floor: f,
      label: `${f.building_short || f.building_name} · ${f.floor_number} этаж`,
      title: `${f.building_name}, ${f.floor_number} этаж`,
      buildingId: f.building_id,
      floorNumber: f.floor_number,
      w: Number(f.svg_width) || 4000,
      h: Number(f.svg_height) || 1400,
      hasPlan: !!f.svg_file,
    }));

    if (mode.value === 'floor') {
      return sized.map((b) => ({ ...b, x: 0, y: 0 }));
    }

    // Группировка по корпусам с сохранением порядка
    const columns = [];
    for (const block of sized) {
      let column = columns.find((c) => c.buildingId === block.buildingId);
      if (!column) { column = { buildingId: block.buildingId, blocks: [] }; columns.push(column); }
      column.blocks.push(block);
    }
    // Верхний этаж — сверху, как на разрезе здания
    for (const column of columns) column.blocks.sort((a, b) => b.floorNumber - a.floorNumber);

    const maxH = Math.max(...sized.map((b) => b.h), 1);
    const gapY = maxH * GAP_BETWEEN_FLOORS;
    const band = maxH * LABEL_BAND;

    const out = [];
    let cursorX = 0;
    for (const column of columns) {
      const columnW = Math.max(...column.blocks.map((b) => b.w), 1);
      let cursorY = 0;
      for (const block of column.blocks) {
        out.push({
          ...block,
          // Блоки выравниваются по левому краю столбца
          x: cursorX,
          y: cursorY + band,
          columnW,
          labelY: cursorY + band * 0.55,
        });
        cursorY += band + block.h + gapY;
      }
      cursorX += columnW + columnW * GAP_BETWEEN_BUILDINGS;
    }
    return out;
  });

  const blockByFloor = computed(() => new Map(blocks.value.map((b) => [b.floorId, b])));

  /** Смещение блока этажа в общей системе координат холста. */
  function offsetOf(id) {
    const block = blockByFloor.value.get(Number(id));
    return block ? { x: block.x, y: block.y } : { x: 0, y: 0 };
  }

  /** Габариты всей сцены — для вписывания в окно. */
  const sceneBounds = computed(() => {
    if (!blocks.value.length) return { x: 0, y: 0, w: 1000, h: 700 };
    const right = Math.max(...blocks.value.map((b) => b.x + b.w));
    const bottom = Math.max(...blocks.value.map((b) => b.y + b.h));
    const top = Math.min(...blocks.value.map((b) => b.labelY ?? b.y));
    return { x: 0, y: Math.min(top, 0), w: right, h: bottom - Math.min(top, 0) };
  });

  function layerVisible(key) { return !hiddenLayers.value.has(key); }

  function toggleLayer(key) {
    const next = new Set(hiddenLayers.value);
    if (next.has(key)) next.delete(key); else next.add(key);
    hiddenLayers.value = next;
  }

  function showAllLayers() { hiddenLayers.value = new Set(); }

  // --- Узлы, попадающие на карту ---

  const visibleSockets = computed(() => {
    if (!layerVisible('sockets')) return [];
    return sockets.value.filter((s) => s.pos_x != null && s.pos_y != null);
  });

  const visibleDevices = computed(() =>
    devices.value.filter((d) =>
      d.pos_x != null && d.pos_y != null && layerVisible(d.layer)
    )
  );

  /**
   * Линии связи. Рисуются только если ОБА конца сейчас на экране:
   * при отключении слоя коммутаторов связь «компьютер - свитч»
   * исчезает вместе с ним, как требует задание.
   */
  const links = computed(() => {
    if (!showLinks.value) return [];
    const out = [];
    const visibleDeviceIds = new Set(visibleDevices.value.map((d) => d.id));
    const visibleSocketIds = new Set(visibleSockets.value.map((s) => s.id));

    for (const device of visibleDevices.value) {
      const uplink = device.uplink;
      if (!uplink || uplink.kind === 'none') continue;

      let target = null;
      if (uplink.kind === 'socket') {
        if (!visibleSocketIds.has(uplink.id)) continue;
        target = socketsById.value.get(uplink.id);
      } else {
        if (!visibleDeviceIds.has(uplink.id)) continue;
        target = devicesById.value.get(uplink.id);
      }
      if (!target || target.pos_x == null || target.pos_y == null) continue;

      out.push({
        id: `${uplink.kind}-${uplink.id}-${device.id}`,
        // Координаты локальные, в системе своего этажа. Смещение блока
        // добавляет холст: в общем виде концы связи могут оказаться
        // на разных этажах.
        x1: device.pos_x, y1: device.pos_y, floor1: device.floor_id,
        x2: target.pos_x, y2: target.pos_y, floor2: target.floor_id,
        medium: uplink.medium || 'ethernet',
        from: device.id,
        to: `${uplink.kind}:${uplink.id}`,
      });
    }
    return out;
  });

  /** Связи, примыкающие к выделенному объекту - для подсветки. */
  const highlightedLinks = computed(() => {
    const sel = selection.value;
    if (!sel) return new Set();
    const keys = new Set();
    for (const link of links.value) {
      if (sel.kind === 'device' && (link.from === sel.id || link.to === `device:${sel.id}`)) {
        keys.add(link.id);
      }
      if (sel.kind === 'socket' && link.to === `socket:${sel.id}`) keys.add(link.id);
    }
    return keys;
  });

  // --- Загрузка ---

  /** Подгружает план этажа, если его ещё нет в памяти. */
  async function ensureSvg(id) {
    if (svgCache.value.has(id)) return;
    let text = '';
    try {
      const response = await fetch(structureApi.floorSvgUrl(id), { credentials: 'same-origin' });
      if (response.ok) text = await response.text();
    } catch { /* плана нет или он недоступен - покажем пустой блок */ }
    const next = new Map(svgCache.value);
    next.set(id, text);
    svgCache.value = next;
  }

  async function loadFloor(id, { keepSelection = false } = {}) {
    if (id == null) return;
    loading.value = true;
    error.value = null;
    try {
      floorId.value = Number(id);
      mode.value = 'floor';
      const data = await mapApi.floor(id);
      floor.value = data.floor;
      rooms.value = data.rooms;
      sockets.value = data.sockets;
      devices.value = data.devices;
      if (data.floor.svg_file) await ensureSvg(Number(id));
      if (!keepSelection) selection.value = null;
    } catch (err) {
      error.value = err.message;
      throw err;
    } finally {
      loading.value = false;
    }
  }

  /**
   * Общий вид: все этажи всех корпусов на одном холсте.
   *
   * Планы подгружаются здесь же, параллельно. Это единственное место,
   * где приложение может задуматься на секунду-другую, поэтому режим
   * включается вручную, а не по умолчанию.
   */
  async function loadBuildingView() {
    loading.value = true;
    error.value = null;
    try {
      const data = await mapApi.allFloors();
      floorsMeta.value = data.floors;
      rooms.value = data.rooms;
      sockets.value = data.sockets;
      devices.value = data.devices;
      mode.value = 'building';

      await Promise.all(
        data.floors.filter((f) => f.svg_file).map((f) => ensureSvg(f.id))
      );
      if (floorId.value) {
        floor.value = data.floors.find((f) => f.id === floorId.value) || floor.value;
      }
    } catch (err) {
      error.value = err.message;
      throw err;
    } finally {
      loading.value = false;
    }
  }

  /** Переключение режима с сохранением выделения. */
  async function setMode(next) {
    if (next === mode.value) return;
    if (next === 'building') await loadBuildingView();
    else await loadFloor(floorId.value || floorsMeta.value[0]?.id, { keepSelection: true });
  }

  /** Перечитывает данные, не трогая планы и выделение. */
  async function refresh() {
    if (mode.value === 'building') {
      const data = await mapApi.allFloors();
      floorsMeta.value = data.floors;
      rooms.value = data.rooms;
      sockets.value = data.sockets;
      devices.value = data.devices;
    } else if (floorId.value != null) {
      const data = await mapApi.floor(floorId.value);
      rooms.value = data.rooms;
      sockets.value = data.sockets;
      devices.value = data.devices;
    }
    await refreshUnplaced();
  }

  /** Оборудование вне помещений - для боковой полосы. */
  async function refreshUnplaced() {
    try {
      unplaced.value = (await mapApi.unplaced()).devices;
    } catch { /* полоса просто останется пустой */ }
  }

  /** Сбрасывает план из памяти - после загрузки нового файла. */
  function dropSvg(id) {
    const next = new Map(svgCache.value);
    next.delete(Number(id));
    svgCache.value = next;
  }

  // --- Выделение ---

  function select(kind, id) {
    selection.value = kind ? { kind, id: Number(id) } : null;
  }
  function clearSelection() { selection.value = null; }

  function flash(kind, id, ms = 3000) {
    highlightId.value = `${kind}:${id}`;
    setTimeout(() => {
      if (highlightId.value === `${kind}:${id}`) highlightId.value = null;
    }, ms);
  }

  const selectedRoom = computed(() =>
    selection.value?.kind === 'room' ? roomsById.value.get(selection.value.id) : null
  );
  const selectedDevice = computed(() =>
    selection.value?.kind === 'device' ? devicesById.value.get(selection.value.id) : null
  );
  const selectedSocket = computed(() =>
    selection.value?.kind === 'socket' ? socketsById.value.get(selection.value.id) : null
  );

  /** Содержимое кабинета - для карточки помещения. */
  function roomContents(roomId) {
    return {
      sockets: sockets.value.filter((s) => s.room_id === roomId),
      devices: devices.value.filter((d) => d.room_id === roomId),
    };
  }

  // --- Изменения ---

  /** Локально применяет изменения устройства, не дожидаясь перезагрузки. */
  function patchDeviceLocal(id, changes) {
    const index = devices.value.findIndex((d) => d.id === id);
    if (index === -1) return;
    devices.value = devices.value.map((d, i) => (i === index ? { ...d, ...changes } : d));
  }

  function patchSocketLocal(id, changes) {
    const index = sockets.value.findIndex((s) => s.id === id);
    if (index === -1) return;
    sockets.value = sockets.value.map((s, i) => (i === index ? { ...s, ...changes } : s));
  }

  /**
   * Перемещение иконки. Отправляет координаты и, если сменился кабинет,
   * новую привязку к помещению.
   */
  async function moveDevice(id, { pos_x, pos_y, room_id }) {
    const body = { pos_x, pos_y };
    if (room_id !== undefined) body.room_id = room_id;
    patchDeviceLocal(id, body);
    const result = await deviceApi.update(id, body);
    patchDeviceLocal(id, result.device);
    return result.device;
  }

  async function moveSocket(id, { pos_x, pos_y, room_id }) {
    const body = { pos_x, pos_y };
    if (room_id !== undefined) body.room_id = room_id;
    patchSocketLocal(id, body);
    const result = await networkApi.updateSocket(id, body);
    patchSocketLocal(id, { ...result.socket });
    return result.socket;
  }

  /** Переподключение устройства. Сервер сам проверяет допустимость. */
  async function connectDevice(id, uplink, extra = {}) {
    const result = await deviceApi.update(id, { uplink, ...extra });
    patchDeviceLocal(id, result.device);
    return result.device;
  }

  async function removeDevice(id) {
    await deviceApi.remove(id);
    devices.value = devices.value.filter((d) => d.id !== id);
    // Подключённые снизу устройства остаются, но теряют связь
    devices.value = devices.value.map((d) =>
      d.uplink?.kind === 'device' && d.uplink.id === id
        ? { ...d, uplink: { kind: 'none', id: null, medium: null } }
        : d
    );
    if (selection.value?.kind === 'device' && selection.value.id === id) clearSelection();
  }

  function upsertDevice(device) {
    const index = devices.value.findIndex((d) => d.id === device.id);
    if (index === -1) devices.value = [...devices.value, device];
    else devices.value = devices.value.map((d, i) => (i === index ? device : d));
  }

  function upsertSocket(socket) {
    const index = sockets.value.findIndex((s) => s.id === socket.id);
    if (index === -1) sockets.value = [...sockets.value, socket];
    else sockets.value = sockets.value.map((s, i) => (i === index ? socket : s));
  }

  function removeSocketLocal(id) {
    sockets.value = sockets.value.filter((s) => s.id !== id);
    if (selection.value?.kind === 'socket' && selection.value.id === id) clearSelection();
  }

  /** Пакетное сохранение координат после авторазмещения. */
  async function savePositions(payload) {
    if (!payload.devices?.length && !payload.sockets?.length) return;
    await mapApi.savePositions(payload);
    for (const d of payload.devices || []) patchDeviceLocal(d.id, { pos_x: d.pos_x, pos_y: d.pos_y });
    for (const s of payload.sockets || []) patchSocketLocal(s.id, { pos_x: s.pos_x, pos_y: s.pos_y });
  }

  /** Сколько объектов ещё не размещено на плане. */
  const unplacedCount = computed(() => {
    const boundRooms = new Set(rooms.value.filter((r) => r.svg_polygon_id).map((r) => r.id));
    const d = devices.value.filter(
      (x) => (x.pos_x == null || x.pos_y == null) && boundRooms.has(x.room_id)
    ).length;
    const s = sockets.value.filter(
      (x) => (x.pos_x == null || x.pos_y == null) && boundRooms.has(x.room_id)
    ).length;
    return d + s;
  });

  return {
    mode, floorId, floor, floorsMeta, rooms, sockets, devices, unplaced,
    svgText, svgCache, loading, error,
    blocks, blockByFloor, offsetOf, sceneBounds,
    selection, highlightId, hiddenLayers, showLabels, showLinks, showInspector,
    roomsById, socketsById, devicesById, roomsByPolygon,
    visibleSockets, visibleDevices, links, highlightedLinks,
    layerVisible, toggleLayer, showAllLayers,
    loadFloor, loadBuildingView, setMode, refresh, refreshUnplaced, ensureSvg, dropSvg,
    select, clearSelection, flash,
    selectedRoom, selectedDevice, selectedSocket, roomContents,
    moveDevice, moveSocket, connectDevice, removeDevice,
    upsertDevice, upsertSocket, removeSocketLocal,
    patchDeviceLocal, patchSocketLocal,
    savePositions, unplacedCount,
  };
});
