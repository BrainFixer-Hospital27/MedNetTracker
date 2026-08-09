/**
 * Обёртка над fetch.
 *
 * Разбирает ответ, вытаскивает понятное сообщение об ошибке и
 * сигнализирует наружу о потере сессии, чтобы маршрутизатор мог
 * увести пользователя на форму входа.
 */

/** Ошибка запроса с кодом и текстом от сервера. */
export class ApiError extends Error {
  constructor(status, code, message, payload) {
    super(message);
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

// Подписчики на «сессия истекла»
const unauthorizedHandlers = new Set();
export function onUnauthorized(fn) {
  unauthorizedHandlers.add(fn);
  return () => unauthorizedHandlers.delete(fn);
}

async function request(method, url, body, options = {}) {
  const init = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (options.signal) init.signal = options.signal;

  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Сервер не отвечает. Проверьте соединение.');
  }

  if (response.status === 401 && !options.silent401) {
    for (const fn of unauthorizedHandlers) fn();
  }

  const isJson = (response.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error || 'http_error',
      payload?.message || `Ошибка ${response.status}`,
      payload
    );
  }
  return payload;
}

/** Собирает строку запроса, отбрасывая пустые значения. */
export function qs(params) {
  const usable = Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!usable.length) return '';
  return '?' + new URLSearchParams(usable).toString();
}

export const api = {
  get:    (url, options)       => request('GET', url, undefined, options),
  post:   (url, body, options) => request('POST', url, body ?? {}, options),
  patch:  (url, body, options) => request('PATCH', url, body ?? {}, options),
  put:    (url, body, options) => request('PUT', url, body ?? {}, options),
  delete: (url, options)       => request('DELETE', url, undefined, options),
};

// --- Конкретные вызовы, сгруппированные по смыслу --------------------

export const authApi = {
  me:       () => api.get('/api/auth/me', { silent401: true }),
  login:    (username, password) => api.post('/api/auth/login', { username, password }),
  logout:   () => api.post('/api/auth/logout'),
  changePassword: (current, next) =>
    api.post('/api/auth/password', { current_password: current, new_password: next }),
};

export const structureApi = {
  buildings:   () => api.get('/api/buildings'),
  createBuilding: (data) => api.post('/api/buildings', data),
  updateBuilding: (id, data) => api.patch(`/api/buildings/${id}`, data),
  deleteBuilding: (id) => api.delete(`/api/buildings/${id}`),

  createFloor: (data) => api.post('/api/floors', data),
  updateFloor: (id, data) => api.patch(`/api/floors/${id}`, data),
  deleteFloor: (id) => api.delete(`/api/floors/${id}`),
  floorSvgUrl: (id) => `/api/floors/${id}/svg`,
  uploadSvg:   (id, payload) => api.put(`/api/floors/${id}/svg`, payload),
  bindings:    (id) => api.get(`/api/floors/${id}/bindings`),
  bind:        (id, polygonId, roomId) =>
    api.post(`/api/floors/${id}/bindings`, { svg_polygon_id: polygonId, room_id: roomId }),
  createRoomsFromSvg: (id, items) => api.post(`/api/floors/${id}/rooms-from-svg`, { items }),

  departments: () => api.get('/api/departments'),
  createDepartment: (data) => api.post('/api/departments', data),
  updateDepartment: (id, data) => api.patch(`/api/departments/${id}`, data),
  deleteDepartment: (id) => api.delete(`/api/departments/${id}`),

  rooms:      (params) => api.get('/api/rooms' + qs(params)),
  createRoom: (data) => api.post('/api/rooms', data),
  updateRoom: (id, data) => api.patch(`/api/rooms/${id}`, data),
  deleteRoom: (id) => api.delete(`/api/rooms/${id}`),
};

export const deviceApi = {
  list:   (params) => api.get('/api/devices' + qs(params)),
  card:   (id) => api.get(`/api/devices/${id}`),
  create: (data) => api.post('/api/devices', data),
  update: (id, data) => api.patch(`/api/devices/${id}`, data),
  remove: (id) => api.delete(`/api/devices/${id}`),
  checkConnection: (id, uplink) => api.post(`/api/devices/${id}/check-connection`, { uplink }),
  exportUrl: (params) => '/api/devices/export.csv' + qs(params),
};

export const networkApi = {
  sockets: (params) => api.get('/api/sockets' + qs(params)),
  createSocket: (data) => api.post('/api/sockets', data),
  updateSocket: (id, data) => api.patch(`/api/sockets/${id}`, data),
  deleteSocket: (id) => api.delete(`/api/sockets/${id}`),
  connectPort: (id, ciscoPortId) =>
    api.patch(`/api/sockets/${id}/connect-port`, { cisco_port_id: ciscoPortId }),

  switches: () => api.get('/api/cisco/switches'),
  createSwitch: (data) => api.post('/api/cisco/switches', data),
  updateSwitch: (id, data) => api.patch(`/api/cisco/switches/${id}`, data),
  deleteSwitch: (id) => api.delete(`/api/cisco/switches/${id}`),
  updatePort: (id, data) => api.patch(`/api/cisco/ports/${id}`, data),
};

export const reportApi = {
  list: () => api.get('/api/reports'),
  preview: (key, scope) => api.get('/api/reports/preview' + qs({ key, ...scope })),
  // Выгрузки открываются обычной ссылкой: кука сессии уходит сама,
  // а браузер сохраняет файл штатным диалогом
  exportUrl: (key, scope) => '/api/reports/export' + qs({ key, ...scope }),
  workbookUrl: (scope) => '/api/reports/workbook' + qs(scope),
  summaryUrl: (scope) => '/api/reports/summary' + qs(scope),
  snapshots: () => api.get('/api/reports/snapshots'),
  takeSnapshot: () => api.post('/api/reports/snapshots'),
};

export const mapApi = {
  meta:  () => api.get('/api/meta'),
  floor: (floorId) => api.get('/api/map' + qs({ floor_id: floorId })),
  allFloors: () => api.get('/api/map/all'),
  unplaced: () => api.get('/api/map/unplaced'),
  search: (q, options) => api.get('/api/search' + qs({ q }), options),
  stats: () => api.get('/api/stats'),
  changelog: (limit) => api.get('/api/changelog' + qs({ limit })),
  savePositions: (payload) => api.patch('/api/positions', payload),
  integrity: () => api.get('/api/integrity'),
  repairIntegrity: () => api.post('/api/integrity/repair'),
};
