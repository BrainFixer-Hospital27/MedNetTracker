import { defineStore } from 'pinia';
import { ref, computed, shallowRef } from 'vue';
import { mapApi, structureApi, deviceApi, networkApi } from '../api.js';
import { useMetaStore } from './core.js';

export const useMapStore = defineStore('map', () => {
  const meta = useMetaStore();

  // --- Данные текущего этажа ---
  const floorId = ref(null);
  const floor = ref(null);
  const rooms = ref([]);
  const sockets = ref([]);
  const devices = ref([]);
  const svgText = shallowRef('');   // текст плана; реактивность по ссылке не нужна
  const loading = ref(false);
  const error = ref(null);

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
  const roomsByPolygon = computed(() => {
    const map = new Map();
    for (const r of rooms.value) if (r.svg_polygon_id) map.set(r.svg_polygon_id, r);
    return map;
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
        x1: device.pos_x, y1: device.pos_y,
        x2: target.pos_x, y2: target.pos_y,
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

  async function loadFloor(id, { keepSelection = false } = {}) {
    if (id == null) return;
    loading.value = true;
    error.value = null;
    try {
      const needSvg = String(id) !== String(floorId.value) || !svgText.value;
      floorId.value = Number(id);
      const data = await mapApi.floor(id);
      floor.value = data.floor;
      rooms.value = data.rooms;
      sockets.value = data.sockets;
      devices.value = data.devices;

      if (needSvg) {
        svgText.value = data.floor.svg_file
          ? await fetch(structureApi.floorSvgUrl(id), { credentials: 'same-origin' })
              .then((r) => (r.ok ? r.text() : ''))
          : '';
      }
      if (!keepSelection) selection.value = null;
    } catch (err) {
      error.value = err.message;
      throw err;
    } finally {
      loading.value = false;
    }
  }

  /** Перечитывает данные этажа, не трогая план и выделение. */
  async function refresh() {
    if (floorId.value == null) return;
    const data = await mapApi.floor(floorId.value);
    rooms.value = data.rooms;
    sockets.value = data.sockets;
    devices.value = data.devices;
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
    floorId, floor, rooms, sockets, devices, svgText, loading, error,
    selection, highlightId, hiddenLayers, showLabels, showLinks, showInspector,
    roomsById, socketsById, devicesById, roomsByPolygon,
    visibleSockets, visibleDevices, links, highlightedLinks,
    layerVisible, toggleLayer, showAllLayers,
    loadFloor, refresh,
    select, clearSelection, flash,
    selectedRoom, selectedDevice, selectedSocket, roomContents,
    moveDevice, moveSocket, connectDevice, removeDevice,
    upsertDevice, upsertSocket, removeSocketLocal,
    patchDeviceLocal, patchSocketLocal,
    savePositions, unplacedCount,
  };
});
