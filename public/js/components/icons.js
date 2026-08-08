/**
 * Пиктограммы. Все нарисованы в системе координат 24x24 штрихом,
 * поэтому одинаково читаются и в рейке интерфейса, и на плане этажа,
 * где их приходится масштабировать в единицы карты (сантиметры).
 */

// --- Значки интерфейса (обводка) ---
export const UI_ICONS = {
  map: 'M9 4 3 7v13l6-3 6 3 6-3V4l-6 3-6-3zM9 4v13M15 7v13',
  table: 'M3 5h18v14H3zM3 10h18M3 15h18M9 5v14',
  server: 'M3 5h18v6H3zM3 13h18v6H3zM7 8h.01M7 16h.01M11 8h4M11 16h4',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.6 1.6 0 008 19.4a1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H2a2 2 0 110-4h.1A1.6 1.6 0 004.6 8a1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V2a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H22a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3',
  logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
  plus: 'M12 5v14M5 12h14',
  close: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z M12 15a3 3 0 100-6 3 3 0 000 6z',
  eyeOff: 'M9.9 4.2A10.9 10.9 0 0112 4c6.4 0 10 7 10 7a18 18 0 01-2.7 3.7M6.6 6.6A18 18 0 002 11s3.6 7 10 7a10.8 10.8 0 005.4-1.4M2 2l20 20M9.9 9.9a3 3 0 004.2 4.2',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  edit: 'M11 4H4v16h16v-7M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4z',
  chevronLeft: 'M15 18l-6-6 6-6',
  chevronRight: 'M9 18l6-6-6-6',
  chevronDown: 'M6 9l6 6 6-6',
  upload: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12',
  download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
  refresh: 'M3 12a9 9 0 0115-6.7L21 8M21 12a9 9 0 01-15 6.7L3 16M21 3v5h-5M3 21v-5h5',
  layers: 'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  link: 'M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7',
  unlink: 'M18.8 13.7 21 11.5a5 5 0 00-7-7l-2.2 2.2M5.2 10.3 3 12.5a5 5 0 007 7l2.2-2.2M2 2l20 20',
  target: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 17a5 5 0 100-10 5 5 0 000 10zM12 13a1 1 0 100-2 1 1 0 000 2z',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 16v-4M12 8h.01',
  warning: 'M10.3 3.9 1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L14.7 3.9a2 2 0 00-3.4 0zM12 9v4M12 17h.01',
  history: 'M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8M3 3v5h5M12 7v5l3 2',
  key: 'M21 2l-2 2m-7.6 7.6a5 5 0 11-7 7 5 5 0 017-7zm0 0L15 8m0 0l3 3 3-3-3-3',
  filter: 'M22 3H2l8 9.5V19l4 2v-8.5L22 3z',
  building: 'M3 21h18M5 21V4a1 1 0 011-1h7a1 1 0 011 1v17M14 9h5a1 1 0 011 1v11M8 7h2M8 11h2M8 15h2',
};

// --- Обозначения оборудования (заливка, 24x24) ---
export const DEVICE_GLYPHS = {
  pc:      'M4 4h11v10H4zM4 16h11v1H4zM17 5h3v13h-3zM18 7h1v1h-1z',
  laptop:  'M5 5h14v9H5zM2 15h20l-1 2H3z',
  printer: 'M7 3h10v4H7zM4 8h16v7h-3v-4H7v4H4zM8 13h8v6H8zM17 10h1.5v1.5H17z',
  mfp:     'M6 2h12v3H6zM4 6h16v6h-3V9H7v3H4zM8 11h8v8H8zM9 13h6v1H9zM9 15h6v1H9z',
  scanner: 'M3 6h18v3H3zM3 11h18v7H3zM6 13h12v1H6zM6 15h9v1H6z',
  switch:  'M2 8h20v8H2zM4 11h2v2H4zM7.5 11h2v2h-2zM11 11h2v2h-2zM14.5 11h2v2h-2zM18 11h2v2h-2z',
  router:  'M3 13h18v6H3zM6 15.5h2v2H6zM10 15.5h2v2h-2zM12 3v6M12 3l-3.5 2M12 3l3.5 2M17 16h3v1.5h-3z',
  medical: 'M4 4h16v13H4zM6 6h12v9H6zM11 8h2v5h-2zM9 10h6v1H9zM9 18h6v2H9z',
  phone:   'M5 3h14v18H5zM8 6h8v5H8zM8 13h2v2H8zM11 13h2v2h-2zM14 13h2v2h-2zM8 17h8v2H8z',
  camera:  'M4 8l13-4 2 6-13 4zM6 14h5v6H6zM17 4l1 3M3 12h2',
  // PoE-коммутатор: тот же корпус с портами, но с молнией питания
  poe_switch: 'M2 9h20v9H2zM4 12h2v3H4zM7.5 12h2v3h-2zM14 12h2v3h-2zM17.5 12h2v3h-2zM12.5 2l-3.5 6h2.5l-1 5 4-6.5h-2.5z',
  // Видеорегистратор: корпус с дисками и индикаторами
  nvr:     'M3 7h18v10H3zM5 9.5h9v1.5H5zM5 12.5h9v1.5H5zM16.5 9.5h2v2h-2zM16.5 13h2v2h-2zM6 18h12v2H6z',
  other:   'M5 5h14v14H5zM8 8h8v8H8z',
  socket:  'M4 4h16v16H4zM8 8h2.5v4H8zM13.5 8H16v4h-2.5zM9 15h6v2H9z',
};

/** Компонент значка интерфейса. */
export const Icon = {
  props: {
    name: { type: String, required: true },
    size: { type: [Number, String], default: 17 },
    width: { type: [Number, String], default: 1.7 },
  },
  template: `
    <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none"
         :stroke-width="width" stroke="currentColor"
         stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <path :d="path" />
    </svg>
  `,
  computed: {
    path() { return UI_ICONS[this.name] || UI_ICONS.info; },
  },
};

/** Обозначение оборудования — заливкой, для плана этажа и списков. */
export const DeviceGlyph = {
  props: {
    glyph: { type: String, default: 'other' },
    size: { type: [Number, String], default: 15 },
  },
  template: `
    <svg :width="size" :height="size" viewBox="0 0 24 24"
         fill="currentColor" aria-hidden="true" focusable="false">
      <path :d="path" />
    </svg>
  `,
  computed: {
    path() { return DEVICE_GLYPHS[this.glyph] || DEVICE_GLYPHS.other; },
  },
};

export default { Icon, DeviceGlyph, UI_ICONS, DEVICE_GLYPHS };
