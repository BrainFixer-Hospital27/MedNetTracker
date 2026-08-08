import { ref, computed, watch } from 'vue';
import { useMapStore } from '../stores/map.js';
import { useMetaStore, useToastStore } from '../stores/core.js';
import { deviceApi } from '../api.js';
import { Icon, DeviceGlyph } from './icons.js';
import { roomTitle, roomSubtitle, deviceTitle } from '../labels.js';

/**
 * Правая панель. Показывает карточку того, что выбрано на карте:
 * помещения, устройства или розетки. Для устройства подтягивает с
 * сервера полную цепочку подключения - её сервер считает сам, обходя
 * связи вверх до порта Cisco.
 */
export const Inspector = {
  components: { Icon, DeviceGlyph },
  emits: ['edit-device', 'add-device', 'edit-socket', 'add-socket',
          'edit-room', 'goto-port', 'disconnect', 'focus'],

  template: `
    <aside class="inspector">

      <!-- ===================== Ничего не выбрано ===================== -->
      <div v-if="!store.selection" class="inspector__empty">
        <div>
          <div class="eyebrow" style="margin-bottom:8px">Ничего не выбрано</div>
          <p style="margin:0;max-width:250px">
            Выберите кабинет или оборудование на карте, чтобы увидеть
            карточку и цепочку подключения.
          </p>
        </div>
      </div>

      <!-- ======================== Помещение ========================= -->
      <template v-else-if="store.selection.kind === 'room' && room">
        <div class="inspector__head">
          <div style="flex:1;min-width:0">
            <span class="eyebrow">Помещение</span>
            <h2 class="inspector__title">{{ roomTitle(room) }}</h2>
            <div v-if="room.name" class="mono"
                 style="color:var(--text-dim);font-size:12.5px">каб. {{ room.room_number }}</div>
          </div>
          <button class="modal__close" @click="store.clearSelection()" title="Закрыть">
            <Icon name="close" :size="15" />
          </button>
        </div>

        <div class="inspector__body">
          <div class="section">
            <dl class="props">
              <dt>Отделение</dt>
              <dd>
                <span v-if="room.department_color" class="color-dot"
                      :style="{ background: room.department_color, display:'inline-block',
                                marginRight:'6px', verticalAlign:'middle' }"></span>
                {{ room.department_name || '—' }}
              </dd>
              <dt>Этаж</dt>
              <dd>{{ store.floor?.building_name }}, {{ store.floor?.floor_number }}</dd>
              <dt v-if="room.area">Площадь</dt>
              <dd v-if="room.area" class="mono">{{ room.area }} м²</dd>
              <dt>Фигура плана</dt>
              <dd class="mono" style="font-size:12px">{{ room.svg_polygon_id || 'не привязана' }}</dd>
            </dl>
            <p v-if="room.notes" style="margin:9px 0 0;color:var(--text-dim);font-size:12.5px">
              {{ room.notes }}
            </p>
          </div>

          <div class="section">
            <span class="eyebrow">Розетки — {{ contents.sockets.length }}</span>
            <ul v-if="contents.sockets.length" class="child-list">
              <li v-for="socket in contents.sockets" :key="socket.id"
                  @click="store.select('socket', socket.id)">
                <DeviceGlyph glyph="socket" :size="14" style="color:var(--muted)" />
                <span class="mono">{{ socket.label }}</span>
                <span style="margin-left:auto;color:var(--muted);font-size:11.5px">
                  {{ socket.port_number ? socket.switch_name + '/' + socket.port_number : 'нет линии' }}
                </span>
              </li>
            </ul>
            <p v-else style="color:var(--muted);font-size:12.5px;margin:4px 0">
              В кабинете не заведено ни одной розетки.
            </p>
            <button class="btn btn--sm" style="margin-top:8px" @click="$emit('add-socket', room.id)">
              <Icon name="plus" :size="13" /> Добавить розетку
            </button>
          </div>

          <div class="section">
            <span class="eyebrow">Оборудование — {{ contents.devices.length }}</span>
            <ul v-if="contents.devices.length" class="child-list">
              <li v-for="device in contents.devices" :key="device.id"
                  @click="store.select('device', device.id)">
                <DeviceGlyph :glyph="device.icon" :size="14"
                             :style="{ color: meta.layerColor(device.layer) }" />
                <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                  {{ title(device) }}
                </span>
                <span v-if="device.uplink.kind === 'none'" class="tag"
                      style="margin-left:auto;color:var(--warn)">нет связи</span>
              </li>
            </ul>
            <p v-else style="color:var(--muted);font-size:12.5px;margin:4px 0">
              Оборудование не числится.
            </p>
            <button class="btn btn--sm" style="margin-top:8px" @click="$emit('add-device', room.id)">
              <Icon name="plus" :size="13" /> Добавить оборудование
            </button>
          </div>
        </div>

        <div class="inspector__foot">
          <button class="btn btn--sm" @click="$emit('edit-room', room.id)">
            <Icon name="edit" :size="13" /> Изменить помещение
          </button>
          <button class="btn btn--sm" @click="$emit('focus', 'room', room.id)">
            <Icon name="target" :size="13" /> Показать
          </button>
        </div>
      </template>

      <!-- ========================= Розетка ========================== -->
      <template v-else-if="store.selection.kind === 'socket' && socket">
        <div class="inspector__head">
          <div style="flex:1;min-width:0">
            <span class="eyebrow">Сетевая розетка</span>
            <h2 class="inspector__title mono">{{ socket.label }}</h2>
          </div>
          <button class="modal__close" @click="store.clearSelection()" title="Закрыть">
            <Icon name="close" :size="15" />
          </button>
        </div>

        <div class="inspector__body">
          <div class="section">
            <dl class="props">
              <dt>Кабинет</dt>
              <dd>{{ socketRoom ? roomTitle(socketRoom) : '—' }}</dd>
              <dt>Линия до серверной</dt>
              <dd>
                <template v-if="socket.port_number">
                  <span class="mono">{{ socket.switch_name }} / порт {{ socket.port_number }}</span>
                </template>
                <span v-else style="color:var(--warn)">не заведена</span>
              </dd>
              <dt v-if="socket.notes">Примечание</dt>
              <dd v-if="socket.notes">{{ socket.notes }}</dd>
            </dl>
          </div>

          <div class="section">
            <span class="eyebrow">Подключено — {{ socketDevices.length }}</span>
            <ul v-if="socketDevices.length" class="child-list">
              <li v-for="device in socketDevices" :key="device.id"
                  @click="store.select('device', device.id)">
                <DeviceGlyph :glyph="device.icon" :size="14"
                             :style="{ color: meta.layerColor(device.layer) }" />
                <span>{{ title(device) }}</span>
              </li>
            </ul>
            <p v-else style="color:var(--muted);font-size:12.5px;margin:4px 0">
              Розетка свободна.
            </p>
          </div>
        </div>

        <div class="inspector__foot">
          <button class="btn btn--sm" @click="$emit('edit-socket', socket.id)">
            <Icon name="edit" :size="13" /> Изменить
          </button>
          <button class="btn btn--sm" @click="$emit('focus', 'socket', socket.id)">
            <Icon name="target" :size="13" /> Показать
          </button>
        </div>
      </template>

      <!-- ======================== Устройство ======================== -->
      <template v-else-if="store.selection.kind === 'device' && device">
        <div class="inspector__head">
          <div style="flex:1;min-width:0">
            <span class="eyebrow">{{ device.type_label }}</span>
            <h2 class="inspector__title">{{ title(device) }}</h2>
          </div>
          <button class="modal__close" @click="store.clearSelection()" title="Закрыть">
            <Icon name="close" :size="15" />
          </button>
        </div>

        <div class="inspector__body">
          <div class="section">
            <dl class="props">
              <dt>Состояние</dt>
              <dd>
                <span class="badge" :style="{ color: meta.statusColor(device.status) }">
                  <i class="badge__dot"></i>{{ meta.statusLabel(device.status) }}
                </span>
              </dd>
              <template v-if="device.inventory_number">
                <dt>Инв. номер</dt><dd class="mono">{{ device.inventory_number }}</dd>
              </template>
              <template v-if="device.serial_number">
                <dt>Серийный</dt><dd class="mono">{{ device.serial_number }}</dd>
              </template>
              <template v-if="device.mac_address">
                <dt>MAC</dt><dd class="mono">{{ device.mac_address }}</dd>
              </template>
              <template v-if="device.ip_address">
                <dt>IP</dt><dd class="mono">{{ device.ip_address }}</dd>
              </template>
              <template v-if="device.responsible_person">
                <dt>Ответственный</dt><dd>{{ device.responsible_person }}</dd>
              </template>
              <template v-if="device.cartridge_model">
                <dt>Картридж</dt><dd class="mono">{{ device.cartridge_model }}</dd>
              </template>
              <template v-if="device.ports_count">
                <dt>Портов</dt>
                <dd class="mono">
                  {{ card?.port_usage
                      ? card.port_usage.used + ' из ' + device.ports_count + ' занято'
                      : device.ports_count }}
                </dd>
              </template>
            </dl>
          </div>

          <!-- Реквизиты доступа: показываются по нажатию и сами прячутся -->
          <div v-if="hasSecrets" class="section">
            <span class="eyebrow">Реквизиты доступа</span>
            <dl class="props">
              <template v-if="card?.device?.wifi_ssid">
                <dt>Сеть Wi-Fi</dt><dd class="mono">{{ card.device.wifi_ssid }}</dd>
              </template>
              <template v-if="card?.device?.wifi_password">
                <dt>Пароль Wi-Fi</dt>
                <dd><button class="btn btn--sm mono" @click="reveal('wifi')">
                  {{ shown.wifi ? card.device.wifi_password : '••••••••' }}
                </button></dd>
              </template>
              <template v-if="card?.device?.router_login">
                <dt>Логин панели</dt><dd class="mono">{{ card.device.router_login }}</dd>
              </template>
              <template v-if="card?.device?.router_password">
                <dt>Пароль панели</dt>
                <dd><button class="btn btn--sm mono" @click="reveal('router')">
                  {{ shown.router ? card.device.router_password : '••••••••' }}
                </button></dd>
              </template>
            </dl>
          </div>

          <!-- ================== Лента цепочки ================== -->
          <div class="section">
            <span class="eyebrow">Цепочка подключения</span>
            <ol v-if="chain.length" class="chain">
              <li v-for="(link, index) in chain" :key="link.kind + link.id"
                  class="chain__item"
                  :class="chainClass(link, index)">
                <div class="eyebrow chain__role">{{ link.type_label }}</div>
                <div class="chain__label">{{ link.label }}</div>
              </li>
            </ol>
            <div v-if="chainBreak" class="chain__break">
              <Icon name="warning" :size="12" style="vertical-align:-2px" />
              {{ chainBreak }}
            </div>
          </div>

          <div v-if="children.length" class="section">
            <span class="eyebrow">Подключено к устройству — {{ children.length }}</span>
            <ul class="child-list">
              <li v-for="child in children" :key="child.id"
                  @click="store.select('device', child.id)">
                <DeviceGlyph :glyph="child.icon" :size="14"
                             :style="{ color: meta.layerColor(child.layer) }" />
                <span>{{ title(child) }}</span>
                <span class="tag" style="margin-left:auto">
                  {{ meta.media[child.uplink.medium]?.label || '' }}
                </span>
              </li>
            </ul>
          </div>

          <div v-if="device.notes" class="section">
            <span class="eyebrow">Примечание</span>
            <p style="margin:2px 0 0;font-size:12.5px;color:var(--text-dim)">{{ device.notes }}</p>
          </div>
        </div>

        <div class="inspector__foot">
          <button class="btn btn--sm" @click="$emit('edit-device', device.id)">
            <Icon name="edit" :size="13" /> Изменить
          </button>
          <button class="btn btn--sm" @click="$emit('focus', 'device', device.id)">
            <Icon name="target" :size="13" /> Показать
          </button>
          <button v-if="device.uplink.kind !== 'none'" class="btn btn--sm"
                  @click="$emit('disconnect', device.id)">
            <Icon name="unlink" :size="13" /> Отключить
          </button>
        </div>
      </template>
    </aside>
  `,

  setup(props, { emit }) {
    const store = useMapStore();
    const meta = useMetaStore();
    const toasts = useToastStore();

    const card = ref(null);            // подробности с сервера
    const shown = ref({ wifi: false, router: false });
    let hideTimer = null;

    const room = computed(() => store.selectedRoom);
    const socket = computed(() => store.selectedSocket);
    const device = computed(() => store.selectedDevice);

    const contents = computed(() =>
      room.value ? store.roomContents(room.value.id) : { sockets: [], devices: [] }
    );

    const socketRoom = computed(() =>
      socket.value ? store.roomsById.get(socket.value.room_id) : null
    );

    const socketDevices = computed(() =>
      socket.value
        ? store.devices.filter((d) => d.uplink.kind === 'socket' && d.uplink.id === socket.value.id)
        : []
    );

    const chain = computed(() => card.value?.chain || []);
    const children = computed(() => card.value?.children || []);

    const hasSecrets = computed(() => {
      const d = card.value?.device;
      return !!(d && (d.wifi_ssid || d.wifi_password || d.router_login || d.router_password));
    });

    /** Поясняет, где цепочка обрывается - разрывы допустимы, но их видно. */
    const chainBreak = computed(() => {
      const links = chain.value;
      if (!links.length) return null;
      const last = links[links.length - 1];
      if (last.kind === 'cisco_port') return null;
      if (last.kind === 'socket') return 'Розетка не заведена на коммутатор Cisco.';
      if (links.length === 1) return 'Устройство ни к чему не подключено.';
      return 'Цепочка обрывается: дальше связь не прослеживается.';
    });

    function chainClass(link, index) {
      return {
        'chain__item--self': index === 0,
        'chain__item--cisco': link.kind === 'cisco_port',
        'chain__item--usb': link.medium === 'usb',
        'chain__item--wifi': link.medium === 'wifi',
      };
    }

    /** Показывает пароль и через несколько секунд прячет обратно. */
    function reveal(key) {
      shown.value = { ...shown.value, [key]: !shown.value[key] };
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { shown.value = { wifi: false, router: false }; }, 8000);
    }

    async function loadCard(id) {
      card.value = null;
      shown.value = { wifi: false, router: false };
      if (!id) return;
      try {
        card.value = await deviceApi.card(id);
      } catch (err) {
        toasts.error(err.message);
      }
    }

    watch(
      () => (store.selection?.kind === 'device' ? store.selection.id : null),
      (id) => loadCard(id),
      { immediate: true }
    );

    // Карточку нужно перечитывать и после изменения связей
    watch(() => store.devices, () => {
      if (store.selection?.kind === 'device') loadCard(store.selection.id);
    });

    return {
      store, meta, card, shown,
      room, socket, device, contents, socketRoom, socketDevices,
      chain, children, chainBreak, hasSecrets,
      chainClass, title: deviceTitle, roomTitle, roomSubtitle, reveal,
    };
  },
};

export default Inspector;
