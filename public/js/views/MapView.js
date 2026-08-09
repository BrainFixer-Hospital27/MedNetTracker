import { ref, computed, watch, onMounted, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMapStore } from '../stores/map.js';
import { useMetaStore, useToastStore } from '../stores/core.js';
import MapCanvas from '../components/MapCanvas.js';
import UnplacedTray from '../components/UnplacedTray.js';
import Inspector from '../components/Inspector.js';
import ConnectDialog from '../components/ConnectDialog.js';
import { DeviceForm, SocketForm, RoomForm } from '../components/forms.js';
import { Modal } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { deviceTitle, roomTitle } from '../labels.js';
import { deviceApi } from '../api.js';

export const MapView = {
  components: { MapCanvas, UnplacedTray, Inspector, ConnectDialog, DeviceForm, SocketForm, RoomForm, Modal, Icon },

  template: `
    <div class="map" :class="{ 'is-panel-hidden': !store.showInspector }">
      <UnplacedTray @drag-start="startTrayDrag"
                    @edit="openDeviceForm"
                    @add="openNewDevice(null)" />

      <!-- Призрак перетаскиваемой из полосы иконки -->
      <div v-if="trayDrag" class="tray-ghost"
           :style="{ left: trayDrag.x + 14 + 'px', top: trayDrag.y + 16 + 'px' }">
        {{ trayDrag.title }}
      </div>

      <MapCanvas ref="canvasRef"
                 @connect-request="onConnectRequest"
                 @after-move="onAfterMove"
                 @open-device="onOpenDevice"
                 @open-room="() => {}" />

      <!-- Язычок сворачивания правой панели. Один орган управления на
           все состояния: и когда что-то выбрано, и когда ничего. -->
      <button type="button" class="panel-handle"
              :title="store.showInspector ? 'Свернуть панель' : 'Развернуть панель'"
              @click="store.showInspector = !store.showInspector">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
          <path :d="store.showInspector ? 'M9 18l6-6-6-6' : 'M15 18l-6-6 6-6'" />
        </svg>
        <span v-if="!store.showInspector && selectionLabel" class="panel-handle__label">
          {{ selectionLabel }}
        </span>
      </button>

      <Inspector @edit-device="openDeviceForm"
                 @add-device="openNewDevice"
                 @edit-socket="openSocketForm"
                 @add-socket="openNewSocket"
                 @edit-room="openRoomForm"
                 @disconnect="disconnect"
                 @focus="focusOn" />

      <!-- Форма оборудования -->
      <DeviceForm v-if="deviceForm.open"
                  :key="'df' + (deviceForm.id || 'new') + (deviceForm.roomId || '')"
                  :device-id="deviceForm.id"
                  :room-id="deviceForm.roomId"
                  @saved="onDeviceSaved"
                  @deleted="onDeviceDeleted"
                  @close="deviceForm.open = false" />

      <!-- Форма розетки -->
      <SocketForm v-if="socketForm.open"
                  :key="'sf' + (socketForm.id || 'new') + (socketForm.roomId || '')"
                  :socket-id="socketForm.id"
                  :room-id="socketForm.roomId"
                  @saved="onSocketSaved"
                  @deleted="onSocketDeleted"
                  @close="socketForm.open = false" />

      <!-- Форма помещения -->
      <RoomForm v-if="roomForm.open" :key="'rf' + (roomForm.id || 'new')"
                :room-id="roomForm.id"
                @saved="onRoomSaved" @deleted="onRoomDeleted"
                @close="roomForm.open = false" />

      <!-- Подтверждение переподключения -->
      <ConnectDialog v-if="connectRequest"
                     :device-id="connectRequest.deviceId"
                     :target="connectRequest.target"
                     :position="connectRequest.position"
                     @done="connectRequest = null"
                     @close="onConnectCancel" />

      <!-- Предложение перепривязать после переезда в другой кабинет -->
      <Modal v-if="relocation" title="Оборудование переехало" @close="relocation = null">
        <p style="margin:0 0 12px">
          <span class="mono">{{ relocation.title }}</span> теперь числится
          в помещении «{{ relocation.roomTitle }}»
          (<span class="mono">{{ relocation.roomNumber }}</span>).
        </p>

        <template v-if="relocation.sockets.length">
          <p style="margin:0 0 8px;color:var(--text-dim)">
            Прежнее подключение осталось в старом кабинете. Выберите розетку
            на новом месте или оставьте как есть.
          </p>
          <div class="field">
            <select class="select" v-model="relocation.choice">
              <option value="">— оставить прежнее подключение —</option>
              <option v-for="socket in relocation.sockets" :key="socket.id"
                      :value="'socket:' + socket.id">
                Розетка {{ socket.label }}{{ socket.port_number
                  ? ' → ' + socket.switch_name + '/' + socket.port_number : ' (без линии)' }}
              </option>
            </select>
          </div>
        </template>
        <div v-else class="note note--warn">
          В новом кабинете нет ни одной розетки. Подключение осталось прежним —
          проверьте его вручную.
        </div>

        <template #footer>
          <button class="btn" @click="relocation = null">Оставить как есть</button>
          <button v-if="relocation.sockets.length" class="btn btn--primary"
                  :disabled="!relocation.choice" @click="applyRelocation">
            Переподключить
          </button>
        </template>
      </Modal>
    </div>
  `,

  setup() {
    const store = useMapStore();
    const meta = useMetaStore();
    const toasts = useToastStore();
    const route = useRoute();
    const router = useRouter();

    const canvasRef = ref(null);

    /** Что выбрано сейчас — подписывается на свёрнутом язычке,
        чтобы выбор на карте не пропадал из виду вместе с панелью. */
    const selectionLabel = computed(() => {
      const sel = store.selection;
      if (!sel) return '';
      if (sel.kind === 'device') return deviceTitle(store.devicesById.get(sel.id));
      if (sel.kind === 'room') return roomTitle(store.roomsById.get(sel.id));
      const socket = store.socketsById.get(sel.id);
      return socket ? 'Розетка ' + socket.label : '';
    });
    const deviceForm = ref({ open: false, id: null, roomId: null });
    const socketForm = ref({ open: false, id: null, roomId: null });
    const roomForm = ref({ open: false, id: null });
    const connectRequest = ref(null);
    const relocation = ref(null);
    const trayDrag = ref(null);

    // =================================================================
    //  Перетаскивание из полосы «Не размещено»
    //
    //  Полоса живёт вне холста, поэтому событиями указателя занимается
    //  этот экран, а холст только отвечает на вопрос «что под курсором».
    // =================================================================
    function startTrayDrag(event, device) {
      if (event.button !== 0) return;
      event.preventDefault();
      trayDrag.value = {
        id: device.id, title: deviceTitle(device),
        x: event.clientX, y: event.clientY,
      };
      window.addEventListener('pointermove', onTrayMove);
      window.addEventListener('pointerup', onTrayDrop, { once: true });
    }

    function onTrayMove(event) {
      if (!trayDrag.value) return;
      trayDrag.value = { ...trayDrag.value, x: event.clientX, y: event.clientY };
    }

    async function onTrayDrop(event) {
      window.removeEventListener('pointermove', onTrayMove);
      const state = trayDrag.value;
      trayDrag.value = null;
      if (!state) return;

      const target = canvasRef.value?.resolveDrop(event.clientX, event.clientY);
      if (!target) {
        toasts.error('Отпустите иконку внутри помещения на плане');
        return;
      }

      try {
        await deviceApi.update(state.id, {
          room_id: target.roomId, pos_x: target.pos_x, pos_y: target.pos_y,
        });
        const room = store.roomsById.get(target.roomId);
        toasts.ok(`Размещено: ${roomTitle(room)}`);
        await store.refresh();
        store.select('device', state.id);
        store.flash('device', state.id);
      } catch (err) {
        toasts.error(err.message);
      }
    }

    // =================================================================
    //  Загрузка этажа по адресу
    // =================================================================
    async function syncFromRoute() {
      const floorId = Number(route.query.floor) || defaultFloorId();
      if (!floorId) return;
      if (store.floorId !== floorId) {
        try {
          await store.loadFloor(floorId);
        } catch (err) {
          toasts.error('Не удалось открыть этаж: ' + err.message);
          return;
        }
      }
      await nextTick();
      applyTargetFromRoute();
    }

    function defaultFloorId() {
      const first = meta.buildings.find((b) => (b.floors || []).length);
      return first ? first.floors[0].id : null;
    }

    /** Переход из поиска: выделить и показать нужный объект. */
    function applyTargetFromRoute() {
      const { device, socket, room } = route.query;
      if (device) {
        store.select('device', device);
        store.flash('device', Number(device));
        focusOn('device', Number(device));
      } else if (socket) {
        store.select('socket', socket);
        store.flash('socket', Number(socket));
        focusOn('socket', Number(socket));
      } else if (room) {
        store.select('room', room);
        store.flash('room', Number(room));
        focusOn('room', Number(room));
      }
    }

    function focusOn(kind, id) {
      nextTick(() => canvasRef.value?.focusOn(kind, Number(id)));
    }

    onMounted(() => { syncFromRoute(); store.refreshUnplaced(); });
    watch(() => route.query, syncFromRoute);

    // =================================================================
    //  Формы
    // =================================================================
    function openDeviceForm(id) {
      deviceForm.value = { open: true, id: Number(id), roomId: null };
    }
    function openNewDevice(roomId) {
      deviceForm.value = { open: true, id: null, roomId: roomId ? Number(roomId) : null };
    }
    function openSocketForm(id) {
      socketForm.value = { open: true, id: Number(id), roomId: null };
    }
    function openNewSocket(roomId) {
      socketForm.value = { open: true, id: null, roomId: roomId ? Number(roomId) : null };
    }
    function openRoomForm(id) {
      roomForm.value = { open: true, id: Number(id) };
    }

    /** Двойной щелчок по иконке открывает карточку; одиночный — только выделяет. */
    function onOpenDevice(id, selectOnly = false) {
      if (selectOnly) return;
      openDeviceForm(id);
    }

    async function onDeviceSaved(device) {
      deviceForm.value = { open: false, id: null, roomId: null };
      await store.refresh();
      await store.refreshUnplaced();
      if (device?.id) store.select('device', device.id);
    }

    async function onDeviceDeleted() {
      deviceForm.value = { open: false, id: null, roomId: null };
      store.clearSelection();
      await store.refresh();
    }

    async function onSocketSaved(socket) {
      socketForm.value = { open: false, id: null, roomId: null };
      await store.refresh();
      if (socket?.id) store.select('socket', socket.id);
    }

    async function onSocketDeleted() {
      socketForm.value = { open: false, id: null, roomId: null };
      store.clearSelection();
      await store.refresh();
    }

    async function onRoomSaved(room) {
      roomForm.value = { open: false, id: null };
      await store.refresh();
      await meta.reloadStructure();
      if (room?.id) store.select('room', room.id);
    }

    async function onRoomDeleted() {
      roomForm.value = { open: false, id: null };
      store.clearSelection();
      await store.refresh();
      await meta.reloadStructure();
    }

    // =================================================================
    //  Перетаскивание
    // =================================================================
    function onConnectRequest(payload) {
      connectRequest.value = payload;
    }

    /** Отказ от переподключения: возвращаем иконку на прежнее место. */
    async function onConnectCancel() {
      connectRequest.value = null;
      await store.refresh();
    }

    /**
     * Устройство перетащили в другой кабинет. Координаты и привязка
     * уже сохранены; предлагаем заодно пересадить его на розетку
     * нового кабинета - обычно именно это и требуется.
     */
    function onAfterMove({ device, roomId }) {
      const room = store.roomsById.get(roomId);
      if (!room) return;
      if (!meta.canPlugIntoSocket(device.type)) return;

      relocation.value = {
        deviceId: device.id,
        title: deviceTitle(device),
        roomNumber: room.room_number,
        roomTitle: roomTitle(room),
        sockets: store.sockets.filter((s) => s.room_id === roomId),
        choice: '',
      };
    }

    async function applyRelocation() {
      const state = relocation.value;
      if (!state?.choice) return;
      const [kind, id] = state.choice.split(':');
      try {
        await store.connectDevice(state.deviceId, { kind, id: Number(id) });
        toasts.ok('Подключение обновлено');
      } catch (err) {
        toasts.error(err.message);
      } finally {
        relocation.value = null;
      }
    }

    async function disconnect(deviceId) {
      try {
        await store.connectDevice(deviceId, { kind: 'none', id: null });
        toasts.info('Устройство отключено от сети');
      } catch (err) {
        toasts.error(err.message);
      }
    }

    return {
      store, canvasRef, selectionLabel,
      deviceForm, socketForm, roomForm, connectRequest, relocation, trayDrag,
      startTrayDrag,
      openDeviceForm, openNewDevice, openSocketForm, openNewSocket, openRoomForm, onOpenDevice,
      onDeviceSaved, onDeviceDeleted, onSocketSaved, onSocketDeleted,
      onRoomSaved, onRoomDeleted,
      onConnectRequest, onConnectCancel, onAfterMove, applyRelocation,
      disconnect, focusOn,
    };
  },
};

export default MapView;
