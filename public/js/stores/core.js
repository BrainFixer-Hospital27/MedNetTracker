import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { authApi, mapApi, structureApi } from '../api.js';

// =====================================================================
//  Сессия
// =====================================================================
export const useAuthStore = defineStore('auth', () => {
  const user = ref(null);
  const checked = ref(false);

  const isAuthenticated = computed(() => !!user.value);

  async function check() {
    try {
      const data = await authApi.me();
      user.value = data.user;
    } catch {
      user.value = null;
    } finally {
      checked.value = true;
    }
    return user.value;
  }

  async function login(username, password) {
    const data = await authApi.login(username, password);
    user.value = data.user;
    return data.user;
  }

  async function logout() {
    try { await authApi.logout(); } finally { user.value = null; }
  }

  /** Вызывается при 401 от любого запроса. */
  function dropSession() { user.value = null; }

  return { user, checked, isAuthenticated, check, login, logout, dropSession };
});

// =====================================================================
//  Справочник предметной области + структура здания.
//  Загружается один раз после входа и живёт всё время работы.
// =====================================================================
export const useMetaStore = defineStore('meta', () => {
  const layers = ref([]);
  const media = ref({});
  const deviceTypes = ref({});
  const deviceStatuses = ref({});
  const portStatuses = ref({});
  const fieldLabels = ref({});

  const buildings = ref([]);
  const departments = ref([]);
  const loaded = ref(false);

  async function load(force = false) {
    if (loaded.value && !force) return;
    const [meta, structure, depts] = await Promise.all([
      mapApi.meta(), structureApi.buildings(), structureApi.departments(),
    ]);
    layers.value = meta.layers;
    media.value = meta.media;
    deviceTypes.value = meta.device_types;
    deviceStatuses.value = meta.device_statuses;
    portStatuses.value = meta.port_statuses;
    fieldLabels.value = meta.field_labels;
    buildings.value = structure.buildings;
    departments.value = depts.departments;
    loaded.value = true;
  }

  async function reloadStructure() {
    const [structure, depts] = await Promise.all([
      structureApi.buildings(), structureApi.departments(),
    ]);
    buildings.value = structure.buildings;
    departments.value = depts.departments;
  }

  // --- Производные справочники ---

  const floorsById = computed(() => {
    const map = new Map();
    for (const b of buildings.value) {
      for (const f of b.floors || []) map.set(f.id, { ...f, building: b });
    }
    return map;
  });

  const departmentsById = computed(
    () => new Map(departments.value.map((d) => [d.id, d]))
  );

  /** Типы, сгруппированные по слоям карты - для переключателей и фильтров. */
  const typesByLayer = computed(() => {
    const map = {};
    for (const [key, meta] of Object.entries(deviceTypes.value)) {
      (map[meta.layer] ||= []).push({ key, ...meta });
    }
    return map;
  });

  const typeList = computed(() =>
    Object.entries(deviceTypes.value).map(([key, meta]) => ({ key, ...meta }))
  );

  function typeLabel(key) { return deviceTypes.value[key]?.label || key; }
  function typeShort(key) { return deviceTypes.value[key]?.short || typeLabel(key); }
  function layerOf(key)   { return deviceTypes.value[key]?.layer || 'other'; }
  function statusLabel(key) { return deviceStatuses.value[key]?.label || key; }
  function statusColor(key) { return deviceStatuses.value[key]?.color || 'var(--muted)'; }
  function layerColor(key) {
    return layers.value.find((l) => l.key === key)?.color || 'var(--muted)';
  }

  /** Может ли устройство типа child подключиться к устройству типа parent. */
  function resolveMedium(childType, parentType) {
    const c = deviceTypes.value[childType];
    const p = deviceTypes.value[parentType];
    if (!c || !p) return null;
    for (const medium of ['ethernet', 'usb', 'wifi']) {
      if (c.uplink.includes(medium) && (p.accepts || []).includes(medium)) return medium;
    }
    return null;
  }

  function canPlugIntoSocket(type) {
    return !!deviceTypes.value[type]?.uplink.includes('ethernet');
  }

  /** Дополнительные поля карточки для типа. */
  function extraFields(type) { return deviceTypes.value[type]?.fields || []; }

  return {
    layers, media, deviceTypes, deviceStatuses, portStatuses, fieldLabels,
    buildings, departments, loaded,
    load, reloadStructure,
    floorsById, departmentsById, typesByLayer, typeList,
    typeLabel, typeShort, layerOf, statusLabel, statusColor, layerColor,
    resolveMedium, canPlugIntoSocket, extraFields,
  };
});

// =====================================================================
//  Уведомления
// =====================================================================
export const useToastStore = defineStore('toasts', () => {
  const items = ref([]);
  let nextId = 1;

  function push(message, kind = 'info', ttl = 4200) {
    const id = nextId++;
    items.value.push({ id, message, kind });
    setTimeout(() => dismiss(id), ttl);
    return id;
  }
  function dismiss(id) {
    items.value = items.value.filter((t) => t.id !== id);
  }

  const ok = (m) => push(m, 'ok');
  const error = (m) => push(m, 'error', 6500);
  const info = (m) => push(m, 'info');

  return { items, push, dismiss, ok, error, info };
});
