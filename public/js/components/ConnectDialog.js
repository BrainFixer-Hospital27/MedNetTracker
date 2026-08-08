import { ref, computed, onMounted } from 'vue';
import { useMapStore } from '../stores/map.js';
import { useMetaStore, useToastStore } from '../stores/core.js';
import { deviceApi } from '../api.js';
import { Modal } from './ui.js';
import { Icon, DeviceGlyph } from './icons.js';
import { deviceTitle } from '../labels.js';

/**
 * Всплывает, когда иконку оборудования бросили на другую иконку.
 *
 * Задание требует подтверждения: перетаскивание слишком лёгкое
 * действие, чтобы молча переписать схему подключения. Показываем,
 * что было и что станет, а также предупреждения сервера - например,
 * что у коммутатора кончились свободные порты.
 */
export const ConnectDialog = {
  components: { Modal, Icon, DeviceGlyph },
  props: {
    deviceId: { type: Number, required: true },
    target: { type: Object, required: true },     // { kind, id }
    position: { type: Object, default: null },    // { pos_x, pos_y }
  },
  emits: ['done', 'close'],

  template: `
    <Modal title="Изменение подключения" @close="$emit('close')">
      <div v-if="checking" style="color:var(--muted)">Проверяем совместимость…</div>

      <template v-else>
        <div v-if="!verdict?.ok" class="note note--danger">
          <Icon name="warning" :size="13" style="vertical-align:-2px" />
          {{ verdict?.message || 'Такое подключение невозможно' }}
        </div>

        <template v-else>
          <p style="margin:0 0 14px;color:var(--text-dim)">
            Оборудование будет отключено от прежней точки и подключено к новой.
          </p>

          <div style="display:grid;gap:10px">
            <div style="display:flex;align-items:center;gap:10px">
              <DeviceGlyph :glyph="device?.icon" :size="17"
                           :style="{ color: meta.layerColor(device?.layer) }" />
              <div style="min-width:0">
                <div class="eyebrow">Что подключаем</div>
                <div class="mono" style="font-size:13px">{{ deviceTitle }}</div>
              </div>
            </div>

            <div style="display:flex;align-items:center;gap:10px;
                        padding-left:3px;color:var(--muted)">
              <Icon name="chevronDown" :size="15" />
              <!-- Пара бывает соединима несколькими способами: ноутбук
                   к роутеру - кабелем или по воздуху. Выбор за человеком. -->
              <select v-if="options.length > 1" class="select" style="width:auto"
                      v-model="medium">
                <option v-for="key in options" :key="key" :value="key">
                  {{ meta.media[key]?.label || key }}
                </option>
              </select>
              <span v-else class="tag">
                {{ meta.media[verdict.medium]?.label || verdict.medium }}
              </span>
            </div>

            <div style="display:flex;align-items:center;gap:10px">
              <DeviceGlyph :glyph="targetGlyph" :size="17" style="color:var(--accent)" />
              <div style="min-width:0">
                <div class="eyebrow">Куда</div>
                <div class="mono" style="font-size:13px">{{ targetTitle }}</div>
              </div>
            </div>
          </div>

          <div v-if="wasConnected" class="note" style="margin-top:14px">
            Прежнее подключение: {{ previousTitle }}
          </div>

          <div v-if="verdict.warning" class="note note--warn" style="margin-top:10px">
            <Icon name="warning" :size="13" style="vertical-align:-2px" />
            {{ verdict.warning }}
          </div>
        </template>
      </template>

      <template #footer>
        <button class="btn" @click="$emit('close')" :disabled="saving">Отмена</button>
        <button v-if="verdict?.ok" class="btn btn--primary" @click="apply" :disabled="saving">
          {{ saving ? 'Применяем…' : 'Подключить' }}
        </button>
      </template>
    </Modal>
  `,

  setup(props, { emit }) {
    const store = useMapStore();
    const meta = useMetaStore();
    const toasts = useToastStore();

    const checking = ref(true);
    const saving = ref(false);
    const verdict = ref(null);
    const medium = ref(null);

    const options = computed(() => verdict.value?.options || []);

    const device = computed(() => store.devicesById.get(props.deviceId));

    const title = computed(() => deviceTitle(device.value));

    const targetGlyph = computed(() => {
      if (props.target.kind === 'socket') return 'socket';
      return store.devicesById.get(props.target.id)?.icon || 'other';
    });

    const targetTitle = computed(() => {
      if (props.target.kind === 'socket') {
        const s = store.socketsById.get(props.target.id);
        return s ? 'Розетка ' + s.label : 'розетка';
      }
      return deviceTitle(store.devicesById.get(props.target.id));
    });

    const wasConnected = computed(() => device.value?.uplink?.kind !== 'none');

    const previousTitle = computed(() => {
      const uplink = device.value?.uplink;
      if (!uplink || uplink.kind === 'none') return '';
      if (uplink.kind === 'socket') {
        const s = store.socketsById.get(uplink.id);
        return s ? 'розетка ' + s.label : 'розетка';
      }
      return deviceTitle(store.devicesById.get(uplink.id)) || 'устройство';
    });

    onMounted(async () => {
      try {
        verdict.value = await deviceApi.checkConnection(props.deviceId, props.target);
        medium.value = verdict.value?.medium || null;
      } catch (err) {
        verdict.value = { ok: false, message: err.message };
      } finally {
        checking.value = false;
      }
    });

    async function apply() {
      saving.value = true;
      try {
        await store.connectDevice(
          props.deviceId,
          { ...props.target, medium: medium.value },
          props.position || {}
        );
        toasts.ok('Подключение изменено');
        emit('done');
      } catch (err) {
        toasts.error(err.message);
        await store.refresh();
        emit('close');
      } finally {
        saving.value = false;
      }
    }

    return {
      meta, checking, saving, verdict, medium, options, device, deviceTitle: title,
      targetGlyph, targetTitle, wasConnected, previousTitle, apply,
    };
  },
};

export default ConnectDialog;
