import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useMapStore } from '../stores/map.js';
import { useMetaStore, useToastStore } from '../stores/core.js';
import { DEVICE_GLYPHS } from './icons.js';
import { roomTitle, deviceTitle, shorten } from '../labels.js';

// =====================================================================
//  Вспомогательные функции
// =====================================================================

/** Смешивает два цвета #rrggbb в пропорции t (0 - первый, 1 - второй). */
function mixHex(a, b, t) {
  const parse = (h) => {
    const s = h.replace('#', '');
    const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  };
  try {
    const [r1, g1, b1] = parse(a);
    const [r2, g2, b2] = parse(b);
    const mix = (x, y) => Math.round(x + (y - x) * t);
    return '#' + [mix(r1, r2), mix(g1, g2), mix(b1, b2)]
      .map((v) => v.toString(16).padStart(2, '0')).join('');
  } catch {
    return a;
  }
}

const PAPER = '#e9eeeb';

/**
 * Приводит план из редактора к тому виду, который ожидает приложение:
 * снимает инлайновую заливку с фигур помещений (иначе она перебьёт
 * раскраску по отделениям) и проставляет им класс.
 */
function normalizePlan(root) {
  const shapes = root.querySelectorAll('[id^="room-"]');
  for (const el of shapes) {
    el.classList.add('room');
    el.style.removeProperty('fill');
    el.style.removeProperty('fill-opacity');
    el.removeAttribute('fill');
    if (!el.getAttribute('stroke')) el.style.removeProperty('stroke');
  }
  return shapes.length;
}

export const MapCanvas = {
  emits: ['after-move', 'connect-request', 'open-device', 'open-room'],

  template: `
    <div class="map__canvas"
         ref="canvas"
         :class="{ 'is-panning': panning, 'is-dragging': !!drag,
                   'is-forbidden': dropForbidden, 'is-allowed': dropAllowed }"
         @pointerdown="onBackgroundDown"
         @pointermove="onPointerMove"
         @pointerup="onPointerUp"
         @pointercancel="onPointerUp"
         @lostpointercapture="onPointerUp"
         @wheel.prevent="onWheel">

      <svg ref="svgEl" class="map__svg" :viewBox="viewBox">

        <!-- Подложка плана: сюда переносится содержимое файла этажа -->
        <g ref="planEl" class="floorplan"></g>

        <!-- Подписи помещений -->
        <g v-if="store.showLabels" class="room-labels" pointer-events="none">
          <template v-for="label in roomLabels" :key="label.id">
            <text class="room-label" :x="label.x" :y="label.y"
                  :font-size="label.size">{{ label.number }}</text>
            <text v-if="label.dept" class="room-label room-label--sub"
                  :x="label.x" :y="label.y + label.size * 1.05"
                  :font-size="label.size * 0.66">{{ label.dept }}</text>
          </template>
        </g>

        <!-- Линии связи -->
        <g class="links" pointer-events="none">
          <line v-for="link in renderedLinks" :key="link.id"
                class="link" :class="linkClass(link)"
                :x1="link.x1" :y1="link.y1" :x2="link.x2" :y2="link.y2" />
        </g>

        <!-- Розетки -->
        <g v-if="store.layerVisible('sockets')" class="nodes-sockets">
          <g v-for="socket in placedSockets" :key="'s' + socket.id"
             class="node"
             :class="nodeClass('socket', socket.id)"
             :data-node-kind="'socket'" :data-node-id="socket.id"
             :transform="translate(nodePos('socket', socket))"
             @pointerdown.stop="onNodeDown($event, 'socket', socket)">
            <rect class="node__shape"
                  :x="-socketSize / 2" :y="-socketSize / 2"
                  :width="socketSize" :height="socketSize" :rx="socketSize * 0.16" />
            <path class="node__glyph" :d="glyphPath('socket')"
                  :transform="glyphTransform(socketSize)" />
            <circle v-if="!socket.port_number" class="node__badge"
                    :cx="socketSize * 0.36" :cy="-socketSize * 0.36" :r="socketSize * 0.15" />
          </g>
        </g>

        <!-- Оборудование -->
        <g class="nodes-devices">
          <g v-for="device in placedDevices" :key="'d' + device.id"
             class="node"
             :class="nodeClass('device', device.id)"
             :data-node-kind="'device'" :data-node-id="device.id"
             :data-node-type="device.type" :data-room-of="device.room_id"
             :transform="translate(nodePos('device', device))"
             @pointerdown.stop="onNodeDown($event, 'device', device)"
             @dblclick.stop="$emit('open-device', device.id)">
            <rect class="node__shape"
                  :x="-nodeSize / 2" :y="-nodeSize / 2"
                  :width="nodeSize" :height="nodeSize" :rx="nodeSize * 0.16"
                  :style="{ stroke: layerStroke(device.layer) }" />
            <path class="node__glyph" :d="glyphPath(device.icon)"
                  :transform="glyphTransform(nodeSize)" />
            <circle v-if="device.uplink.kind === 'none'" class="node__badge"
                    :cx="nodeSize * 0.36" :cy="-nodeSize * 0.36" :r="nodeSize * 0.15" />
          </g>
        </g>
      </svg>

      <!-- Всплывающая подсказка -->
      <div v-if="hover" class="hovercard"
           :style="{ left: hover.left + 'px', top: hover.top + 'px' }">
        <div class="hovercard__title">{{ hover.title }}</div>
        <div v-if="hover.meta" class="hovercard__meta">{{ hover.meta }}</div>
      </div>

      <!-- Слои. Панель сворачивается: иначе она перекрывает иконки
           в левом верхнем углу плана, и до них не добраться мышью. -->
      <div class="map__overlay map__layers" :class="{ 'is-collapsed': !showLayers }">
        <button type="button" class="legend-toggle" @click="showLayers = !showLayers"
                :title="showLayers ? 'Свернуть панель' : 'Слои и обозначения'">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
          <span v-if="showLayers" style="flex:1;text-align:left">Слои</span>
          <svg v-if="showLayers" width="11" height="11" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
            <path d="M18 15l-6-6-6 6" />
          </svg>
        </button>

        <template v-if="showLayers">
        <div style="height:1px;background:var(--line-soft);margin:7px 0"></div>
        <label v-for="layer in meta.layers" :key="layer.key" class="checkbox">
          <input type="checkbox" :checked="store.layerVisible(layer.key)"
                 @change="store.toggleLayer(layer.key)">
          <i class="layer-swatch" :style="{ background: layer.color }"></i>
          <span>{{ layer.label }}</span>
        </label>
        <div style="height:1px;background:var(--line-soft);margin:7px 0"></div>
        <label class="checkbox">
          <input type="checkbox" v-model="store.showLinks">
          <span>Связи</span>
        </label>
        <label class="checkbox">
          <input type="checkbox" v-model="store.showLabels">
          <span>Номера кабинетов</span>
        </label>

        <!-- Условные обозначения. Стиль линии показывает среду
             передачи, а красная точка - разрыв цепочки. -->
        <div style="height:1px;background:var(--line-soft);margin:7px 0"></div>
        <button type="button" class="legend-toggle" @click="showLegend = !showLegend">
          <span>Обозначения</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.4" stroke-linecap="round"
               :style="{ transform: showLegend ? 'rotate(180deg)' : 'none' }">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        <div v-if="showLegend" class="map-legend">
          <div class="eyebrow" style="margin:6px 0 4px">Среда передачи</div>
          <div v-for="item in mediaLegend" :key="item.key" class="map-legend__row">
            <svg width="30" height="8" viewBox="0 0 30 8" aria-hidden="true">
              <line x1="1" y1="4" x2="29" y2="4"
                    :stroke="item.color" stroke-width="2.5" stroke-linecap="round"
                    :stroke-dasharray="item.dash" />
            </svg>
            <span>{{ item.label }}</span>
          </div>

          <div class="eyebrow" style="margin:9px 0 4px">Разрывы цепочки</div>
          <div class="map-legend__row">
            <svg width="30" height="14" viewBox="0 0 30 14" aria-hidden="true">
              <rect x="8" y="1.5" width="11" height="11" rx="2"
                    fill="#f7faf9" stroke="#4c5a63" stroke-width="1.3" />
              <circle cx="19" cy="2.5" r="2.6" fill="var(--danger)" />
            </svg>
            <span>не подключено</span>
          </div>
          <p class="map-legend__note">
            У розетки та же метка означает, что линия до коммутатора
            Cisco не заведена.
          </p>
        </div>
        </template>
      </div>

      <!-- Масштаб -->
      <div class="map__overlay map__zoom">
        <button type="button" title="Приблизить" @click="zoomBy(1.3)">+</button>
        <button type="button" title="Отдалить" @click="zoomBy(1 / 1.3)">&minus;</button>
        <button type="button" title="Показать весь этаж" @click="fitToView">&#9634;</button>
      </div>

      <div class="map__overlay map__hint">
        Перетащите иконку в другой кабинет или бросьте её на коммутатор,
        роутер либо компьютер, чтобы переподключить.
      </div>

      <div v-if="!hasPlan" class="map__empty">
        <div>
          <div class="eyebrow" style="margin-bottom:8px">План не загружен</div>
          <p style="max-width:340px;margin:0">
            Для этого этажа ещё нет файла SVG. Загрузите его в разделе
            «Администрирование», и помещения появятся на карте.
          </p>
        </div>
      </div>
    </div>
  `,

  setup(props, { emit }) {
    const store = useMapStore();
    const meta = useMetaStore();
    const toasts = useToastStore();

    const canvas = ref(null);
    const svgEl = ref(null);
    const planEl = ref(null);

    // --- Область просмотра (viewBox) ---
    const view = ref({ x: 0, y: 0, w: 1000, h: 700 });
    const content = ref({ w: 1000, h: 700 });
    const canvasSize = ref({ w: 1000, h: 700 });
    const hasPlan = ref(false);

    const viewBox = computed(() =>
      [view.value.x, view.value.y, view.value.w, view.value.h].join(' ')
    );

    /** Сколько единиц карты приходится на один экранный пиксель. */
    const unitsPerPixel = computed(() =>
      canvasSize.value.w ? view.value.w / canvasSize.value.w : 1
    );

    // Иконки держат постоянный экранный размер: иначе на общем плане
    // этажа они превращаются в неразличимые точки.
    const nodeSize = computed(() => Math.max(unitsPerPixel.value * 26, 8));
    const socketSize = computed(() => Math.max(unitsPerPixel.value * 19, 6));

    // --- Геометрия помещений, снятая с плана ---
    const roomBoxes = ref(new Map());   // svg_polygon_id -> {x,y,width,height}

    // =================================================================
    //  Загрузка плана в холст
    // =================================================================
    function mountPlan() {
      const host = planEl.value;
      if (!host) return;
      host.replaceChildren();
      roomBoxes.value = new Map();
      hasPlan.value = false;
      if (!store.svgText) return;

      const doc = new DOMParser().parseFromString(store.svgText, 'image/svg+xml');
      const root = doc.querySelector('svg');
      if (!root || doc.querySelector('parsererror')) {
        toasts.error('Не удалось разобрать файл плана этажа');
        return;
      }

      normalizePlan(root);

      const box = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
      content.value = box.length === 4
        ? { w: box[2], h: box[3], x: box[0], y: box[1] }
        : { w: Number(root.getAttribute('width')) || 1000,
            h: Number(root.getAttribute('height')) || 700, x: 0, y: 0 };

      for (const node of Array.from(root.childNodes)) {
        host.appendChild(document.importNode(node, true));
      }
      hasPlan.value = true;

      measureRooms();
      paintRooms();
      fitToView();
    }

    /** Снимает габариты каждой фигуры помещения - нужны для раскладки. */
    function measureRooms() {
      const boxes = new Map();
      for (const el of planEl.value.querySelectorAll('[id^="room-"]')) {
        try {
          const b = el.getBBox();
          boxes.set(el.id, { x: b.x, y: b.y, width: b.width, height: b.height });
        } catch { /* фигура без геометрии - пропускаем */ }
      }
      roomBoxes.value = boxes;
    }

    /** Красит помещения в цвета их отделений. */
    function paintRooms() {
      if (!planEl.value) return;
      for (const el of planEl.value.querySelectorAll('.room')) {
        const room = store.roomsByPolygon.get(el.id);
        const color = room?.department_color;
        el.style.fill = color ? mixHex(PAPER, color, 0.22) : '';
        el.classList.toggle('room--nodept', !!room && !color);
        el.dataset.roomId = room ? String(room.id) : '';
      }
      applyRoomState();
    }

    /** Обновляет классы выделения и подсветки на фигурах. */
    function applyRoomState() {
      if (!planEl.value) return;
      const selectedId = store.selection?.kind === 'room' ? store.selection.id : null;
      const flashed = store.highlightId?.startsWith('room:')
        ? Number(store.highlightId.slice(5)) : null;
      for (const el of planEl.value.querySelectorAll('.room')) {
        const id = Number(el.dataset.roomId || 0);
        el.classList.toggle('is-selected', !!id && id === selectedId);
        el.classList.toggle('is-found', !!id && id === flashed);
      }
    }

    // =================================================================
    //  Масштаб и панорамирование
    // =================================================================
    function measureCanvas() {
      if (!canvas.value) return;
      const rect = canvas.value.getBoundingClientRect();
      canvasSize.value = { w: rect.width, h: rect.height };
    }

    /**
     * Реакция на изменение размеров холста: свернули правую панель,
     * растянули окно. Масштаб сохраняем прежним, а видимую область
     * расширяем под новые габариты - тогда освободившееся место сразу
     * занимает карта, а не пустые поля по краям.
     */
    function syncViewToCanvas() {
      if (!canvas.value) return;
      const rect = canvas.value.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const previousScale = canvasSize.value.w ? view.value.w / canvasSize.value.w : null;
      const centerX = view.value.x + view.value.w / 2;
      const centerY = view.value.y + view.value.h / 2;
      canvasSize.value = { w: rect.width, h: rect.height };

      if (!previousScale) return;
      const w = previousScale * rect.width;
      const h = w * (rect.height / rect.width);
      view.value = { x: centerX - w / 2, y: centerY - h / 2, w, h };
    }

    function fitToView() {
      measureCanvas();
      const pad = 0.04;
      const cw = content.value.w || 1000;
      const ch = content.value.h || 700;
      const aspect = canvasSize.value.w / Math.max(canvasSize.value.h, 1);
      let w = cw * (1 + pad * 2);
      let h = ch * (1 + pad * 2);
      if (w / h < aspect) w = h * aspect; else h = w / aspect;
      view.value = {
        x: (content.value.x || 0) + cw / 2 - w / 2,
        y: (content.value.y || 0) + ch / 2 - h / 2,
        w, h,
      };
    }

    function zoomBy(factor, centerClient) {
      const before = centerClient ? clientToSvg(centerClient.x, centerClient.y) : null;
      const minW = 60;
      const maxW = (content.value.w || 1000) * 4;
      const w = Math.min(Math.max(view.value.w / factor, minW), maxW);
      const h = w * (view.value.h / view.value.w);
      const next = { x: view.value.x, y: view.value.y, w, h };

      if (before) {
        // Держим точку под курсором на месте
        const rect = canvas.value.getBoundingClientRect();
        const rx = (centerClient.x - rect.left) / rect.width;
        const ry = (centerClient.y - rect.top) / rect.height;
        next.x = before.x - w * rx;
        next.y = before.y - h * ry;
      } else {
        next.x = view.value.x + (view.value.w - w) / 2;
        next.y = view.value.y + (view.value.h - h) / 2;
      }
      view.value = next;
    }

    function onWheel(event) {
      zoomBy(event.deltaY < 0 ? 1.14 : 1 / 1.14, { x: event.clientX, y: event.clientY });
    }

    /** Экранные координаты -> координаты карты. */
    function clientToSvg(clientX, clientY) {
      const svg = svgEl.value;
      if (!svg) return { x: 0, y: 0 };
      const point = svg.createSVGPoint();
      point.x = clientX;
      point.y = clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return { x: 0, y: 0 };
      const local = point.matrixTransform(ctm.inverse());
      return { x: local.x, y: local.y };
    }

    // --- Панорамирование фона ---
    const panning = ref(false);
    let panStart = null;

    function onBackgroundDown(event) {
      if (event.button !== 0 && event.button !== 1) return;

      // Переключатели слоёв, кнопки масштаба и подсказка лежат поверх
      // холста. Нажатие на них - это работа с органами управления,
      // а не с картой: панорамирование начинать не нужно.
      if (event.target.closest?.('.map__overlay')) return;

      const nodeHit = event.target.closest?.('[data-node-kind]');
      if (nodeHit) return;   // по иконке начинается перетаскивание

      const roomHit = event.target.closest?.('.room');
      if (roomHit && event.button === 0) {
        const id = Number(roomHit.dataset.roomId || 0);
        if (id) { store.select('room', id); emit('open-room', id); }
      } else if (event.button === 0 && !roomHit) {
        store.clearSelection();
      }

      panning.value = true;
      panStart = {
        clientX: event.clientX, clientY: event.clientY,
        viewX: view.value.x, viewY: view.value.y,
        pointerId: event.pointerId,
      };
      // Захват обязательно на холсте: обработчики движения и отпускания
      // висят на нём же. Если поставить захват на вложенный <svg>,
      // события до холста уже не дойдут и панорамирование не выключится.
      capture(event.pointerId);
    }

    /** Захват и освобождение указателя - всегда на элементе холста. */
    function capture(pointerId) {
      try { canvas.value?.setPointerCapture(pointerId); } catch { /* указателя уже нет */ }
    }
    function release(pointerId) {
      if (pointerId == null) return;
      try {
        if (canvas.value?.hasPointerCapture(pointerId)) {
          canvas.value.releasePointerCapture(pointerId);
        }
      } catch { /* указателя уже нет */ }
    }

    function onPointerMove(event) {
      if (drag.value) return onDragMove(event);
      if (panning.value && panStart) {
        const scale = unitsPerPixel.value;
        view.value = {
          ...view.value,
          x: panStart.viewX - (event.clientX - panStart.clientX) * scale,
          y: panStart.viewY - (event.clientY - panStart.clientY) * scale,
        };
        return;
      }
      updateHover(event);
    }

    function onPointerUp(event) {
      if (drag.value) return onDragEnd(event);
      if (panning.value) {
        release(panStart?.pointerId ?? event.pointerId);
        panning.value = false;
        panStart = null;
      }
    }

    // =================================================================
    //  Подсказка при наведении
    // =================================================================
    const hover = ref(null);
    const showLegend = ref(false);
    const showLayers = ref(true);

    /** Образцы линий для условных обозначений - строятся из CSS-правил,
        чтобы легенда не разошлась с тем, что нарисовано на карте. */
    const mediaLegend = computed(() => ([
      { key: 'ethernet', label: 'Ethernet', color: '#4b6b7a', dash: 'none' },
      { key: 'usb',      label: 'USB',      color: '#8a6ea8', dash: '7 5' },
      { key: 'wifi',     label: 'Wi-Fi',    color: '#3f8fa8', dash: '2 6' },
    ]));

    function updateHover(event) {
      const rect = canvas.value?.getBoundingClientRect();
      if (!rect) return;

      const nodeHit = event.target.closest?.('[data-node-kind]');
      if (nodeHit) {
        const kind = nodeHit.dataset.nodeKind;
        const id = Number(nodeHit.dataset.nodeId);
        const info = kind === 'device' ? describeDevice(id) : describeSocket(id);
        if (info) {
          hover.value = {
            ...info,
            left: event.clientX - rect.left + 14,
            top: event.clientY - rect.top + 14,
          };
          return;
        }
      }

      const roomHit = event.target.closest?.('.room');
      if (roomHit) {
        const room = store.roomsById.get(Number(roomHit.dataset.roomId || 0));
        if (room) {
          const contents = store.roomContents(room.id);
          hover.value = {
            title: roomTitle(room),
            meta: [
              room.name ? 'каб. ' + room.room_number : null,
              room.department_name || 'без отделения',
              contents.devices.length + ' устр.',
              contents.sockets.length + ' роз.',
            ].filter(Boolean).join(' · '),
            left: event.clientX - rect.left + 14,
            top: event.clientY - rect.top + 14,
          };
          return;
        }
      }
      hover.value = null;
    }

    function describeDevice(id) {
      const d = store.devicesById.get(id);
      if (!d) return null;
      return {
        title: deviceTitle(d),
        meta: [d.type_label, d.inventory_number, d.responsible_person]
          .filter(Boolean).join(' · '),
      };
    }

    function describeSocket(id) {
      const s = store.socketsById.get(id);
      if (!s) return null;
      return {
        title: 'Розетка ' + s.label,
        meta: s.port_number
          ? s.switch_name + ' · порт ' + s.port_number
          : 'не заведена на коммутатор',
      };
    }

    // =================================================================
    //  Перетаскивание иконок
    // =================================================================
    const drag = ref(null);       // { kind, id, x, y, moved, dropTarget }
    const rejected = ref(null);   // иконка, только что вернувшаяся на место

    /** Цель под курсором несовместима - показываем курсор запрета. */
    const dropForbidden = computed(() =>
      !!drag.value && drag.value.dropTarget?.type === 'node' && !drag.value.dropTarget.ok
    );
    /** Цель совместима - подсказываем, что бросок сработает. */
    const dropAllowed = computed(() =>
      !!drag.value && drag.value.dropTarget?.type === 'node' && drag.value.dropTarget.ok
    );

    /** Помечает иконку как отклонённую на пару секунд. */
    function markRejected(kind, id) {
      rejected.value = { kind, id };
      setTimeout(() => {
        if (rejected.value?.kind === kind && rejected.value?.id === id) rejected.value = null;
      }, 1400);
    }

    function onNodeDown(event, kind, item) {
      if (event.button !== 0) return;
      store.select(kind, item.id);
      if (kind === 'device') emit('open-device', item.id, true);

      const point = clientToSvg(event.clientX, event.clientY);
      drag.value = {
        kind, id: item.id,
        x: item.pos_x, y: item.pos_y,
        offsetX: point.x - item.pos_x,
        offsetY: point.y - item.pos_y,
        moved: false,
        dropTarget: null,
        pointerId: event.pointerId,
      };
      capture(event.pointerId);
      hover.value = null;
    }

    function onDragMove(event) {
      const state = drag.value;
      if (!state) return;
      const point = clientToSvg(event.clientX, event.clientY);
      const nx = point.x - state.offsetX;
      const ny = point.y - state.offsetY;
      if (Math.abs(nx - state.x) + Math.abs(ny - state.y) > unitsPerPixel.value * 2) {
        state.moved = true;
      }
      state.x = nx;
      state.y = ny;

      // Что окажется под курсором, если сейчас отпустить
      state.dropTarget = findDropTarget(event.clientX, event.clientY, state);
      drag.value = { ...state };
    }

    /**
     * Определяет цель броска. Приоритет у иконки оборудования:
     * бросок на неё означает переподключение, бросок на пустое место
     * кабинета - просто перемещение.
     */
    function findDropTarget(clientX, clientY, state) {
      const stack = document.elementsFromPoint(clientX, clientY);
      for (const el of stack) {
        const nodeHit = el.closest?.('[data-node-kind]');
        if (nodeHit) {
          const kind = nodeHit.dataset.nodeKind;
          const id = Number(nodeHit.dataset.nodeId);
          if (kind === state.kind && id === state.id) continue;   // сам себя пропускаем
          if (state.kind !== 'device') continue;                  // розетку никуда не втыкают
          const verdict = checkTarget(state.id, kind, id);
          return { type: 'node', kind, id, ...verdict };
        }
        const roomHit = el.closest?.('.room');
        if (roomHit) {
          const roomId = Number(roomHit.dataset.roomId || 0);
          if (roomId) return { type: 'room', id: roomId, ok: true };
        }
      }
      return null;
    }

    /** Быстрая проверка совместимости на клиенте - только для подсветки. */
    function checkTarget(deviceId, targetKind, targetId) {
      const child = store.devicesById.get(deviceId);
      if (!child) return { ok: false, reason: 'Устройство не найдено' };

      if (targetKind === 'socket') {
        return meta.canPlugIntoSocket(child.type)
          ? { ok: true, medium: 'ethernet' }
          : { ok: false, reason: meta.typeLabel(child.type) + ' не включается в розетку' };
      }
      const parent = store.devicesById.get(targetId);
      if (!parent) return { ok: false, reason: 'Цель не найдена' };
      const medium = meta.resolveMedium(child.type, parent.type);
      return medium
        ? { ok: true, medium }
        : { ok: false, reason: 'К «' + meta.typeLabel(parent.type) + '» это подключить нельзя' };
    }

    async function onDragEnd(event) {
      const state = drag.value;
      drag.value = null;
      if (!state) return;
      release(state.pointerId);
      if (!state.moved) return;

      const target = state.dropTarget || findDropTarget(event.clientX, event.clientY, state);

      // --- Бросок на другое оборудование или розетку: переподключение ---
      if (target?.type === 'node') {
        if (!target.ok) {
          // Ничего не сохраняем: ни связь, ни координаты. Иконка
          // отрисуется по данным из хранилища, то есть вернётся туда,
          // откуда её взяли.
          markRejected(state.kind, state.id);
          toasts.error(target.reason || 'Такое подключение невозможно');
          return;
        }
        emit('connect-request', {
          deviceId: state.id,
          target: { kind: target.kind, id: target.id },
          position: { pos_x: round(state.x), pos_y: round(state.y) },
        });
        return;
      }

      // --- Бросок в помещение: перемещение ---
      const item = state.kind === 'device'
        ? store.devicesById.get(state.id) : store.socketsById.get(state.id);
      if (!item) return;

      // Мимо всех помещений: иконка, лежащая вне плана, ни о чём не
      // говорит и только мешает. Возвращаем на прежнее место.
      if (!target) {
        markRejected(state.kind, state.id);
        toasts.error('Разместить можно только внутри помещения');
        return;
      }

      const roomId = target?.type === 'room' ? target.id : item.room_id;
      const changedRoom = roomId !== item.room_id;
      const payload = { pos_x: round(state.x), pos_y: round(state.y) };
      if (changedRoom) payload.room_id = roomId;

      try {
        if (state.kind === 'device') {
          const updated = await store.moveDevice(state.id, payload);
          if (changedRoom) emit('after-move', { device: updated, roomId });
        } else {
          await store.moveSocket(state.id, payload);
        }
      } catch (err) {
        toasts.error(err.message);
        await store.refresh();
      }
    }

    const round = (v) => Math.round(v * 10) / 10;

    // =================================================================
    //  Отрисовка узлов
    // =================================================================

    /** Положение узла с поправкой на активное перетаскивание. */
    function nodePos(kind, item) {
      const state = drag.value;
      if (state && state.kind === kind && state.id === item.id) {
        return { x: state.x, y: state.y };
      }
      return { x: item.pos_x, y: item.pos_y };
    }

    const translate = (p) => 'translate(' + p.x + ' ' + p.y + ')';

    const placedDevices = computed(() => store.visibleDevices);
    const placedSockets = computed(() => store.visibleSockets);

    const renderedLinks = computed(() => {
      const state = drag.value;
      if (!state) return store.links;
      // Пока иконку тащат, примыкающие связи тянутся за ней
      return store.links.map((link) => {
        if (state.kind === 'device' && link.from === state.id) {
          return { ...link, x1: state.x, y1: state.y };
        }
        const key = state.kind + ':' + state.id;
        if (link.to === key) return { ...link, x2: state.x, y2: state.y };
        return link;
      });
    });

    function linkClass(link) {
      return [
        'link--' + link.medium,
        store.highlightedLinks.has(link.id) ? 'is-highlight' : '',
      ];
    }

    function nodeClass(kind, id) {
      const sel = store.selection;
      const state = drag.value;
      const target = state?.dropTarget;
      return {
        'is-selected': sel?.kind === kind && sel.id === id,
        'is-found': store.highlightId === kind + ':' + id,
        'is-dragging': state?.kind === kind && state.id === id,
        'is-droptarget': target?.type === 'node' && target.kind === kind
          && target.id === id && target.ok,
        'is-invalidtarget': target?.type === 'node' && target.kind === kind
          && target.id === id && !target.ok,
        // Отказ помечается на самой перетаскиваемой иконке: она
        // возвращается на место, и надо показать, почему
        'is-rejected': rejected.value?.kind === kind && rejected.value?.id === id,
        'is-refused': state?.kind === kind && state.id === id
          && target?.type === 'node' && !target.ok,
      };
    }

    function glyphPath(name) { return DEVICE_GLYPHS[name] || DEVICE_GLYPHS.other; }

    /** Вписывает обозначение 24x24 в квадрат узла. */
    function glyphTransform(size) {
      const scale = (size * 0.62) / 24;
      return 'translate(' + (-size * 0.31) + ' ' + (-size * 0.31) + ') scale(' + scale + ')';
    }

    function layerStroke(layer) { return meta.layerColor(layer); }

    // Подписи помещений: показываем только когда кабинет достаточно
    // крупен на экране, иначе карта превращается в кашу из цифр.
    const roomLabels = computed(() => {
      const out = [];
      const upp = unitsPerPixel.value;
      for (const [polygonId, box] of roomBoxes.value) {
        const room = store.roomsByPolygon.get(polygonId);
        if (!room) continue;
        const widthPx = box.width / upp;
        if (widthPx < 42) continue;
        const size = Math.min(box.height * 0.16, box.width * 0.22, upp * 11);
        if (size / upp < 6.5) continue;
        // Метка ставится в левый верхний угол помещения, как на чертеже:
        // середина кабинета занята иконками оборудования.
        const inset = Math.min(box.width, box.height) * 0.05;
        out.push({
          id: polygonId,
          x: box.x + inset,
          y: box.y + inset,
          size,
          number: room.room_number,
          // Название отделения на плане не пишем: оно дублирует
          // раскраску и захламляет карту. Оно есть в подсказке.
          dept: null,
        });
      }
      return out;
    });

    // =================================================================
    //  Авторазмещение
    //  Геометрию помещений знает только браузер, поэтому раскладку
    //  считаем здесь, а на сервер отправляем готовые координаты.
    // =================================================================
    async function autoPlace() {
      if (!roomBoxes.value.size) return;
      const devicesPayload = [];
      const socketsPayload = [];

      for (const room of store.rooms) {
        if (!room.svg_polygon_id) continue;
        const box = roomBoxes.value.get(room.svg_polygon_id);
        if (!box || !box.width) continue;

        const contents = store.roomContents(room.id);
        const needSockets = contents.sockets.filter((s) => s.pos_x == null || s.pos_y == null);
        const needDevices = contents.devices.filter((d) => d.pos_x == null || d.pos_y == null);
        if (!needSockets.length && !needDevices.length) continue;

        const padX = Math.min(box.width * 0.14, 55);
        // Сверху резервируем полосу под угловую метку с номером кабинета
        const padY = Math.min(box.height * 0.24, 95);
        const innerX = box.x + padX;
        const innerW = Math.max(box.width - padX * 2, 1);

        // Розетки выстраиваются вдоль верхней стены
        const socketsTotal = contents.sockets.length;
        const socketY = box.y + padY;
        contents.sockets.forEach((socket, index) => {
          if (socket.pos_x != null && socket.pos_y != null) return;
          const step = innerW / Math.max(socketsTotal, 1);
          socketsPayload.push({
            id: socket.id,
            pos_x: round(innerX + step * (index + 0.5)),
            pos_y: round(socketY),
          });
        });

        // Оборудование - сеткой в нижней части кабинета
        const devicesTotal = contents.devices.length;
        if (devicesTotal) {
          const cols = Math.max(1, Math.min(Math.ceil(Math.sqrt(devicesTotal * 1.6)),
            Math.floor(innerW / 60) || 1));
          const rows = Math.ceil(devicesTotal / cols);
          const areaTop = socketY + Math.min(box.height * 0.22, 70);
          const areaH = Math.max(box.y + box.height - padY - areaTop, 1);
          contents.devices.forEach((device, index) => {
            if (device.pos_x != null && device.pos_y != null) return;
            const col = index % cols;
            const row = Math.floor(index / cols);
            devicesPayload.push({
              id: device.id,
              pos_x: round(innerX + (innerW / cols) * (col + 0.5)),
              pos_y: round(areaTop + (areaH / rows) * (row + 0.5)),
            });
          });
        }
      }

      if (!devicesPayload.length && !socketsPayload.length) return;
      try {
        await store.savePositions({ devices: devicesPayload, sockets: socketsPayload });
        toasts.info('Размещено на плане: ' + (devicesPayload.length + socketsPayload.length));
      } catch (err) {
        toasts.error('Не удалось сохранить размещение: ' + err.message);
      }
    }

    // =================================================================
    //  Реакция на изменения
    // =================================================================
    let observer = null;

    onMounted(() => {
      measureCanvas();
      observer = new ResizeObserver(() => syncViewToCanvas());
      observer.observe(canvas.value);
      if (store.svgText) mountPlan();
      nextTick(() => autoPlace());
    });

    onBeforeUnmount(() => observer?.disconnect());

    watch(() => store.svgText, () => {
      mountPlan();
      nextTick(() => autoPlace());
    });

    watch(() => store.rooms, () => {
      paintRooms();
      nextTick(() => autoPlace());
    }, { deep: false });

    watch(() => [store.selection, store.highlightId], () => applyRoomState(), { deep: true });

    /** Центрирует карту на объекте - используется поиском. */
    function focusOn(kind, id) {
      let point = null;
      if (kind === 'device') {
        const d = store.devicesById.get(id);
        if (d && d.pos_x != null) point = { x: d.pos_x, y: d.pos_y };
      } else if (kind === 'socket') {
        const s = store.socketsById.get(id);
        if (s && s.pos_x != null) point = { x: s.pos_x, y: s.pos_y };
      } else if (kind === 'room') {
        const room = store.roomsById.get(id);
        const box = room && roomBoxes.value.get(room.svg_polygon_id);
        if (box) point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
      if (!point) return;

      const targetW = Math.min(view.value.w, (content.value.w || 1000) * 0.28);
      const targetH = targetW * (view.value.h / view.value.w);
      view.value = { x: point.x - targetW / 2, y: point.y - targetH / 2, w: targetW, h: targetH };
    }

    return {
      store, meta,
      canvas, svgEl, planEl,
      viewBox, hasPlan, panning, drag, hover, rejected, dropForbidden, dropAllowed,
      showLegend, showLayers, mediaLegend,
      nodeSize, socketSize,
      placedDevices, placedSockets, renderedLinks, roomLabels,
      onBackgroundDown, onPointerMove, onPointerUp, onWheel, onNodeDown,
      zoomBy, fitToView, focusOn, autoPlace,
      nodePos, translate, nodeClass, linkClass, glyphPath, glyphTransform, layerStroke,
    };
  },
};

export default MapCanvas;
