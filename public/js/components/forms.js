import { ref, computed, watch } from 'vue';
import { useMapStore } from '../stores/map.js';
import { useMetaStore, useToastStore } from '../stores/core.js';
import { deviceApi, networkApi, structureApi } from '../api.js';
import { Modal, SecretInput } from './ui.js';
import { Icon } from './icons.js';
import { roomTitle, deviceTitle } from '../labels.js';

// =====================================================================
//  Карточка оборудования: создание и правка
// =====================================================================
export const DeviceForm = {
  components: { Modal, SecretInput, Icon },
  props: {
    deviceId: { type: Number, default: null },
    roomId: { type: Number, default: null },
  },
  emits: ['saved', 'deleted', 'close'],

  template: `
    <Modal :title="deviceId ? 'Карточка оборудования' : 'Новое оборудование'"
           wide @close="$emit('close')">

      <div v-if="loading" style="padding:20px;text-align:center;color:var(--muted)">
        Загружаем карточку…
      </div>

      <form v-else @submit.prevent="save">
        <div class="grid-2">
          <div class="field">
            <label class="eyebrow">Тип оборудования</label>
            <select class="select" v-model="form.type" required>
              <optgroup v-for="layer in meta.layers" :key="layer.key" :label="layer.label">
                <option v-for="type in (meta.typesByLayer[layer.key] || [])"
                        :key="type.key" :value="type.key">{{ type.label }}</option>
              </optgroup>
            </select>
          </div>

          <div class="field">
            <label class="eyebrow">Состояние</label>
            <select class="select" v-model="form.status">
              <option v-for="(info, key) in meta.deviceStatuses" :key="key" :value="key">
                {{ info.label }}
              </option>
            </select>
          </div>
        </div>

        <div class="field">
          <label class="eyebrow">Название</label>
          <input class="input" v-model="form.name"
                 placeholder="Необязательно: рабочее имя, например «Регистратура, стойка 2»">
        </div>

        <div class="grid-2">
          <div class="field">
            <label class="eyebrow">Производитель</label>
            <input class="input" v-model="form.manufacturer" list="mfr-list">
          </div>
          <div class="field">
            <label class="eyebrow">Модель</label>
            <input class="input" v-model="form.model">
          </div>
          <div class="field">
            <label class="eyebrow">Инвентарный номер</label>
            <input class="input mono" v-model="form.inventory_number">
          </div>
          <div class="field">
            <label class="eyebrow">Серийный номер</label>
            <input class="input mono" v-model="form.serial_number">
          </div>
          <div class="field">
            <label class="eyebrow">MAC-адрес</label>
            <input class="input mono" v-model="form.mac_address"
                   placeholder="00:00:00:00:00:00" @blur="normalizeMac">
          </div>
          <div class="field">
            <label class="eyebrow">IP-адрес</label>
            <input class="input mono" v-model="form.ip_address" placeholder="назначается DHCP">
          </div>
        </div>

        <div class="grid-2">
          <div class="field">
            <label class="eyebrow">Помещение</label>
            <!-- Список охватывает все корпуса: оборудование переезжает
                 между отделениями и зданиями, и учёт должен это позволять -->
            <select class="select" v-model.number="form.room_id">
              <option :value="null">— вне помещений (склад) —</option>
              <optgroup v-for="group in meta.roomsByFloor" :key="group.key" :label="group.label">
                <option v-for="room in group.rooms" :key="room.id" :value="room.id">
                  {{ room.room_number }} — {{ roomTitle(room) }}
                </option>
              </optgroup>
            </select>
            <p v-if="movingAway" class="note note--warn" style="margin-top:6px">
              Устройство переезжает на другой этаж. Подключение будет
              разорвано, а положение на плане назначится заново.
            </p>
          </div>
          <div class="field">
            <label class="eyebrow">Ответственный</label>
            <input class="input" v-model="form.responsible_person" list="person-list">
          </div>
        </div>

        <!-- Поля, осмысленные лишь для отдельных типов -->
        <template v-if="extraFields.length">
          <div style="height:1px;background:var(--line-soft);margin:6px 0 12px"></div>
          <div class="grid-2">
            <div v-for="field in extraFields" :key="field" class="field"
                 :style="field.includes('password') ? '' : ''">
              <label class="eyebrow">{{ meta.fieldLabels[field] || field }}</label>
              <SecretInput v-if="field.includes('password')" v-model="form[field]" />
              <input v-else-if="field === 'ports_count'" class="input mono" type="number"
                     min="1" max="48" v-model.number="form.ports_count">
              <input v-else class="input" v-model="form[field]">
            </div>
          </div>
        </template>

        <!-- Подключение -->
        <div style="height:1px;background:var(--line-soft);margin:6px 0 12px"></div>
        <div class="field">
          <label class="eyebrow">Подключено к</label>
          <select class="select" v-model="uplinkKey">
            <option value="none">— не подключено —</option>
            <optgroup v-if="socketOptions.length" label="Розетки кабинета">
              <option v-for="socket in socketOptions" :key="'s' + socket.id"
                      :value="'socket:' + socket.id">
                Розетка {{ socket.label }}{{ socket.port_number
                  ? ' → ' + socket.switch_name + '/' + socket.port_number : '' }}
              </option>
            </optgroup>
            <optgroup v-if="parentOptions.length" label="Оборудование кабинета">
              <option v-for="parent in parentOptions" :key="'d' + parent.id"
                      :value="'device:' + parent.id">
                {{ parent.title }} ({{ parent.mediumLabel }})
              </option>
            </optgroup>
          </select>
          <div v-if="mediumOptions.length > 1" style="margin-top:8px">
            <label class="eyebrow">Среда передачи</label>
            <select class="select" v-model="uplinkMedium">
              <option v-for="key in mediumOptions" :key="key" :value="key">
                {{ meta.media[key]?.label || key }}
              </option>
            </select>
          </div>
          <p v-if="!socketOptions.length && !parentOptions.length && form.room_id"
             style="margin:5px 0 0;font-size:12px;color:var(--muted)">
            {{ movingAway
              ? 'Подключение на новом месте настроите, открыв соответствующий этаж.'
              : 'В этом кабинете нет ни свободных розеток, ни оборудования, к которому можно подключиться.' }}
          </p>
        </div>

        <div class="field">
          <label class="eyebrow">Примечание</label>
          <textarea class="textarea" v-model="form.notes"></textarea>
        </div>

        <datalist id="mfr-list">
          <option v-for="value in knownManufacturers" :key="value" :value="value"></option>
        </datalist>
        <datalist id="person-list">
          <option v-for="value in knownPersons" :key="value" :value="value"></option>
        </datalist>
      </form>

      <template #footer>
        <button v-if="deviceId" class="btn btn--danger" style="margin-right:auto"
                @click="remove" :disabled="saving">
          <Icon name="trash" :size="13" /> Списать
        </button>
        <button class="btn" @click="$emit('close')" :disabled="saving">Отмена</button>
        <button class="btn btn--primary" @click="save" :disabled="saving || !form.type">
          {{ saving ? 'Сохраняем…' : 'Сохранить' }}
        </button>
      </template>
    </Modal>
  `,

  setup(props, { emit }) {
    const store = useMapStore();
    const meta = useMetaStore();
    const toasts = useToastStore();

    const loading = ref(false);
    const saving = ref(false);
    const uplinkKey = ref('none');
    const uplinkMedium = ref(null);

    const blank = () => ({
      type: 'pc', status: 'in_use', name: '', manufacturer: '', model: '',
      serial_number: '', inventory_number: '', mac_address: '', ip_address: '',
      responsible_person: '', notes: '', room_id: props.roomId ?? null,
      ports_count: null, router_login: '', router_password: '',
      wifi_ssid: '', wifi_password: '', cartridge_model: '',
    });

    const form = ref(blank());

    const roomOptions = computed(() =>
      [...store.rooms].sort((a, b) =>
        String(a.room_number).localeCompare(String(b.room_number), 'ru', { numeric: true }))
    );

    const extraFields = computed(() => meta.extraFields(form.value.type));

    /** Розетки выбранного кабинета. */
    const socketOptions = computed(() => {
      if (!form.value.room_id) return [];
      if (!meta.canPlugIntoSocket(form.value.type)) return [];
      return store.sockets.filter((s) => s.room_id === form.value.room_id);
    });

    /** Оборудование кабинета, к которому этот тип можно подключить. */
    const parentOptions = computed(() => {
      if (!form.value.room_id) return [];
      return store.devices
        .filter((d) => d.room_id === form.value.room_id && d.id !== props.deviceId)
        .map((d) => {
          const medium = meta.resolveMedium(form.value.type, d.type);
          if (!medium) return null;
          return {
            id: d.id,
            title: deviceTitle(d),
            type: d.type,
            mediumLabel: meta.media[medium]?.label || medium,
          };
        })
        .filter(Boolean);
    });

    // Среды, которыми выбранная точка подключения достижима
    const mediumOptions = computed(() => {
      if (uplinkKey.value === 'none') return [];
      const [kind, id] = uplinkKey.value.split(':');
      if (kind === 'socket') return ['ethernet'];
      const parent = store.devicesById.get(Number(id));
      if (!parent) return [];
      const child = meta.deviceTypes[form.value.type];
      const accepts = meta.deviceTypes[parent.type]?.accepts || [];
      return ['ethernet', 'usb', 'wifi'].filter(
        (m) => child?.uplink.includes(m) && accepts.includes(m)
      );
    });

    // При смене точки подключения подставляем предпочтительную среду
    watch(mediumOptions, (list) => {
      if (!list.includes(uplinkMedium.value)) uplinkMedium.value = list[0] || null;
    });

    const knownManufacturers = computed(() =>
      [...new Set(store.devices.map((d) => d.manufacturer).filter(Boolean))].sort()
    );
    const knownPersons = computed(() =>
      [...new Set(store.devices.map((d) => d.responsible_person).filter(Boolean))].sort()
    );

    /** Приводит MAC к виду 00:1B:44:11:3A:B7. */
    function normalizeMac() {
      const raw = String(form.value.mac_address || '').replace(/[^0-9a-fA-F]/g, '');
      if (raw.length !== 12) return;
      form.value.mac_address = raw.toUpperCase().match(/.{2}/g).join(':');
    }

    async function load() {
      if (!props.deviceId) {
        form.value = blank();
        uplinkKey.value = 'none';
        return;
      }
      loading.value = true;
      try {
        const data = await deviceApi.card(props.deviceId);
        const d = data.device;
        form.value = { ...blank(), ...d };
        originalFloor.value = floorOf(d.room_id);
        uplinkKey.value = d.uplink.kind === 'none' ? 'none' : d.uplink.kind + ':' + d.uplink.id;
        uplinkMedium.value = d.uplink.medium || null;
      } catch (err) {
        toasts.error(err.message);
        emit('close');
      } finally {
        loading.value = false;
      }
    }

    // При смене типа сбрасываем ставшую невозможной привязку
    watch(() => form.value.type, () => {
      if (uplinkKey.value === 'none') return;
      const [kind, id] = uplinkKey.value.split(':');
      const still = kind === 'socket'
        ? meta.canPlugIntoSocket(form.value.type)
        : !!meta.resolveMedium(form.value.type, store.devicesById.get(Number(id))?.type);
      if (!still) uplinkKey.value = 'none';
    });

    /** Этаж выбранного помещения - для предупреждения о переезде. */
    const floorOf = (roomId) =>
      meta.allRooms.find((r) => r.id === Number(roomId))?.floor_id ?? null;

    const originalFloor = ref(null);
    const movingAway = computed(() =>
      originalFloor.value !== null && form.value.room_id
        && floorOf(form.value.room_id) !== originalFloor.value
    );

    watch(() => form.value.room_id, (next, prev) => {
      if (prev !== undefined && next !== prev) uplinkKey.value = 'none';
    });

    watch(() => props.deviceId, load, { immediate: true });

    function buildUplink() {
      if (uplinkKey.value === 'none') return { kind: 'none', id: null };
      const [kind, id] = uplinkKey.value.split(':');
      return { kind, id: Number(id), medium: uplinkMedium.value || undefined };
    }

    async function save() {
      saving.value = true;
      try {
        const payload = { ...form.value, uplink: buildUplink() };
        delete payload.id;
        delete payload.uplink_socket_label;

        const result = props.deviceId
          ? await deviceApi.update(props.deviceId, payload)
          : await deviceApi.create(payload);

        toasts.ok(props.deviceId ? 'Карточка сохранена' : 'Оборудование добавлено');
        // Сервер мог разорвать связь, потерявшую смысл после переезда,
        // либо отказать в подключении при создании - в обоих случаях
        // человек должен об этом узнать, а не обнаружить потом
        if (result.detached) toasts.info('Подключение снято: ' + result.detached);
        if (result.connection_rejected) toasts.error(result.connection_rejected);
        emit('saved', result.device);
      } catch (err) {
        toasts.error(err.message);
      } finally {
        saving.value = false;
      }
    }

    async function remove() {
      const label = form.value.inventory_number || form.value.model || 'устройство';
      if (!window.confirm('Списать «' + label + '»? Запись будет удалена из учёта.')) return;
      saving.value = true;
      try {
        await deviceApi.remove(props.deviceId);
        toasts.ok('Устройство списано');
        emit('deleted', props.deviceId);
      } catch (err) {
        toasts.error(err.message);
      } finally {
        saving.value = false;
      }
    }

    return {
      meta, form, loading, saving, uplinkKey, uplinkMedium, mediumOptions,
      roomOptions, extraFields, socketOptions, parentOptions,
      knownManufacturers, knownPersons, roomTitle, movingAway,
      normalizeMac, save, remove,
    };
  },
};

// =====================================================================
//  Карточка розетки
// =====================================================================
export const SocketForm = {
  components: { Modal, Icon },
  props: {
    socketId: { type: Number, default: null },
    roomId: { type: Number, default: null },
  },
  emits: ['saved', 'deleted', 'close'],

  template: `
    <Modal :title="socketId ? 'Розетка' : 'Новая розетка'" @close="$emit('close')">
      <form @submit.prevent="save">
        <div class="grid-2">
          <div class="field">
            <label class="eyebrow">Обозначение</label>
            <input class="input mono" v-model="form.label" required
                   placeholder="например 214/3">
          </div>
          <div class="field">
            <label class="eyebrow">Помещение</label>
            <select class="select" v-model.number="form.room_id" required>
              <option v-for="room in roomOptions" :key="room.id" :value="room.id">
                {{ room.room_number }} — {{ roomTitle(room) }}
              </option>
            </select>
          </div>
        </div>

        <div class="field">
          <label class="eyebrow">Порт коммутатора Cisco</label>
          <select class="select" v-model="portKey">
            <option value="">— линия не заведена —</option>
            <optgroup v-for="group in portOptions" :key="group.id" :label="group.name">
              <option v-for="port in group.ports" :key="port.id" :value="String(port.id)">
                порт {{ port.port_number }}{{ port.status === 'damaged' ? ' (повреждён)' : '' }}
              </option>
            </optgroup>
          </select>
          <p style="margin:5px 0 0;font-size:12px;color:var(--muted)">
            Показаны свободные порты и тот, что закреплён за этой розеткой.
          </p>
        </div>

        <div class="field">
          <label class="eyebrow">Примечание</label>
          <textarea class="textarea" v-model="form.notes"></textarea>
        </div>
      </form>

      <template #footer>
        <button v-if="socketId" class="btn btn--danger" style="margin-right:auto"
                @click="remove" :disabled="saving">
          <Icon name="trash" :size="13" /> Удалить
        </button>
        <button class="btn" @click="$emit('close')" :disabled="saving">Отмена</button>
        <button class="btn btn--primary" @click="save"
                :disabled="saving || !form.label || !form.room_id">Сохранить</button>
      </template>
    </Modal>
  `,

  setup(props, { emit }) {
    const store = useMapStore();
    const toasts = useToastStore();

    const saving = ref(false);
    const portKey = ref('');
    const switches = ref([]);
    const form = ref({ label: '', room_id: props.roomId ?? null, notes: '' });

    const roomOptions = computed(() =>
      [...store.rooms].sort((a, b) =>
        String(a.room_number).localeCompare(String(b.room_number), 'ru', { numeric: true }))
    );

    /** Свободные порты плюс текущий - чтобы его было видно в списке. */
    const portOptions = computed(() => {
      const currentId = portKey.value ? Number(portKey.value) : null;
      return switches.value
        .map((sw) => ({
          id: sw.id, name: sw.name,
          ports: sw.ports.filter((p) => (!p.socket_id || p.id === currentId)),
        }))
        .filter((g) => g.ports.length);
    });

    async function load() {
      try {
        switches.value = (await networkApi.switches()).switches;
      } catch (err) {
        toasts.error(err.message);
      }
      if (props.socketId) {
        const socket = store.socketsById.get(props.socketId);
        if (socket) {
          form.value = {
            label: socket.label, room_id: socket.room_id, notes: socket.notes || '',
          };
          portKey.value = socket.cisco_port_id ? String(socket.cisco_port_id) : '';
        }
      }
    }
    load();

    async function save() {
      saving.value = true;
      try {
        const payload = {
          ...form.value,
          cisco_port_id: portKey.value ? Number(portKey.value) : null,
        };
        const result = props.socketId
          ? await networkApi.updateSocket(props.socketId, payload)
          : await networkApi.createSocket(payload);
        toasts.ok('Розетка сохранена');
        emit('saved', result.socket);
      } catch (err) {
        toasts.error(err.message);
      } finally {
        saving.value = false;
      }
    }

    async function remove() {
      if (!window.confirm('Удалить розетку ' + form.value.label + '?')) return;
      saving.value = true;
      try {
        await networkApi.deleteSocket(props.socketId);
        toasts.ok('Розетка удалена');
        emit('deleted', props.socketId);
      } catch (err) {
        toasts.error(err.message);
      } finally {
        saving.value = false;
      }
    }

    return { form, portKey, saving, roomOptions, portOptions, roomTitle, save, remove };
  },
};

// =====================================================================
//  Карточка помещения
// =====================================================================
export const RoomForm = {
  components: { Modal, Icon },
  props: {
    roomId: { type: Number, default: null },
    floorId: { type: Number, default: null },
  },
  emits: ['saved', 'deleted', 'close'],

  template: `
    <Modal :title="roomId ? 'Помещение' : 'Новое помещение'" @close="$emit('close')">
      <form @submit.prevent="save">
        <div class="grid-2">
          <div class="field">
            <label class="eyebrow">Номер по плану</label>
            <input class="input mono" v-model="form.room_number" required placeholder="214">
          </div>
          <div class="field">
            <label class="eyebrow">Площадь, м²</label>
            <input class="input mono" type="number" step="0.1" v-model.number="form.area">
          </div>
        </div>

        <div class="field">
          <label class="eyebrow">Название</label>
          <input class="input" v-model="form.name" list="room-name-list"
                 placeholder="Ординаторская, Манипуляционная, Кабинет заведующего…">
          <p style="margin:5px 0 0;font-size:12px;color:var(--muted)">
            Если оставить пустым, помещение будет называться
            «Кабинет {{ form.room_number || '000' }}».
          </p>
        </div>

        <div class="field">
          <label class="eyebrow">Отделение</label>
          <select class="select" v-model.number="form.department_id">
            <option :value="null">— без отделения —</option>
            <option v-for="dept in meta.departments" :key="dept.id" :value="dept.id">
              {{ dept.name }}
            </option>
          </select>
        </div>

        <div class="field">
          <label class="eyebrow">Фигура на плане этажа</label>
          <input class="input mono" v-model="form.svg_polygon_id" placeholder="room-214">
          <p style="margin:5px 0 0;font-size:12px;color:var(--muted)">
            Заполняется автоматически при загрузке плана. Меняйте, только
            если номер в файле SVG отличается от номера помещения.
          </p>
        </div>

        <div class="field">
          <label class="eyebrow">Примечание</label>
          <textarea class="textarea" v-model="form.notes"></textarea>
        </div>

        <datalist id="room-name-list">
          <option v-for="value in knownNames" :key="value" :value="value"></option>
        </datalist>
      </form>

      <template #footer>
        <button v-if="roomId" class="btn btn--danger" style="margin-right:auto"
                @click="remove" :disabled="saving">
          <Icon name="trash" :size="13" /> Удалить
        </button>
        <button class="btn" @click="$emit('close')" :disabled="saving">Отмена</button>
        <button class="btn btn--primary" @click="save"
                :disabled="saving || !form.room_number">Сохранить</button>
      </template>
    </Modal>
  `,

  setup(props, { emit }) {
    const store = useMapStore();
    const meta = useMetaStore();
    const toasts = useToastStore();

    const saving = ref(false);
    const form = ref({
      room_number: '', name: '', department_id: null,
      area: null, svg_polygon_id: '', notes: '',
      floor_id: props.floorId ?? store.floorId,
    });

    // Названия, уже встречавшиеся в базе - для подсказок при вводе
    const knownNames = computed(() =>
      [...new Set(store.rooms.map((r) => r.name).filter(Boolean))].sort()
    );

    if (props.roomId) {
      const room = store.roomsById.get(props.roomId);
      if (room) {
        form.value = {
          room_number: room.room_number, name: room.name || '',
          department_id: room.department_id ?? null,
          area: room.area ?? null,
          svg_polygon_id: room.svg_polygon_id || '',
          notes: room.notes || '',
          floor_id: room.floor_id,
        };
      }
    }

    async function save() {
      saving.value = true;
      try {
        const result = props.roomId
          ? await structureApi.updateRoom(props.roomId, form.value)
          : await structureApi.createRoom(form.value);
        toasts.ok('Помещение сохранено');
        emit('saved', result.room);
      } catch (err) {
        toasts.error(err.message);
      } finally {
        saving.value = false;
      }
    }

    async function remove() {
      if (!window.confirm('Удалить помещение ' + form.value.room_number + '?')) return;
      saving.value = true;
      try {
        await structureApi.deleteRoom(props.roomId);
        toasts.ok('Помещение удалено');
        emit('deleted', props.roomId);
      } catch (err) {
        toasts.error(err.message);
      } finally {
        saving.value = false;
      }
    }

    return { meta, form, saving, knownNames, save, remove };
  },
};

export default { DeviceForm, SocketForm, RoomForm };
