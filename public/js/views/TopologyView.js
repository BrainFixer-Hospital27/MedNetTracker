import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { networkApi } from '../api.js';
import { useMetaStore, useToastStore } from '../stores/core.js';
import { Modal } from '../components/ui.js';
import { Icon } from '../components/icons.js';

/**
 * Топология магистрального уровня.
 *
 * Коммутаторы нарисованы так, как выглядят на самом деле: порты идут
 * двумя рядами с промежутком через каждые четыре пары. Такое
 * расположение позволяет находить порт на экране тем же движением
 * глаз, что и в серверной.
 */
export const TopologyView = {
  components: { Modal, Icon },

  template: `
    <div class="page">
      <div class="page__head">
        <h1 class="page__title">Топология Cisco</h1>
        <span class="badge">{{ switches.length }} коммутаторов</span>
        <div style="flex:1"></div>
        <div class="legend">
          <span><i style="background:var(--ok)"></i> занят</span>
          <span><i style="background:#2c3840"></i> свободен</span>
          <span><i style="background:#4a8fd6"></i> резерв</span>
          <span><i style="background:var(--danger)"></i> повреждён</span>
        </div>
        <button class="btn btn--sm" @click="load">
          <Icon name="refresh" :size="13" /> Обновить
        </button>
      </div>

      <div v-if="loading" class="table-empty">Загружаем…</div>

      <div v-else class="rack">
        <section v-for="sw in switches" :key="sw.id" class="switch-unit">
          <header class="switch-unit__head">
            <span class="switch-unit__name">{{ sw.name }}</span>
            <span class="switch-unit__meta">{{ sw.model }}</span>
            <span v-if="sw.ip_address" class="tag">{{ sw.ip_address }}</span>
            <span v-if="sw.location" class="switch-unit__meta">{{ sw.location }}</span>
            <div style="flex:1"></div>
            <span class="switch-unit__meta">
              занято <b class="mono" style="color:var(--ok)">{{ sw.used }}</b>
              из <span class="mono">{{ sw.ports.length }}</span>
            </span>
          </header>

          <div class="switch-unit__body">
            <div class="panel-grid">
              <button v-for="port in sw.ports" :key="port.id"
                      class="port"
                      :class="['port--' + port.status,
                               { 'is-selected': selected && selected.id === port.id }]"
                      :title="portTitle(port)"
                      @click="selected = port">
                <i class="port__led"></i>
                {{ port.port_number }}
              </button>
            </div>
          </div>
        </section>
      </div>

      <!-- Карточка порта -->
      <Modal v-if="selected" :title="'Порт ' + selected.port_number" @close="selected = null">
        <dl class="props">
          <dt>Коммутатор</dt>
          <dd class="mono">{{ switchOf(selected)?.name }}</dd>

          <dt>Состояние</dt>
          <dd>
            <select class="select" v-model="selected.status" @change="saveStatus" style="width:auto">
              <option v-for="(info, key) in meta.portStatuses" :key="key" :value="key">
                {{ info.label }}
              </option>
            </select>
          </dd>

          <dt>Розетка</dt>
          <dd>
            <template v-if="selected.socket_label">
              <span class="mono">{{ selected.socket_label }}</span>
            </template>
            <span v-else style="color:var(--muted)">не привязана</span>
          </dd>

          <template v-if="selected.room_number">
            <dt>Расположение</dt>
            <dd>
              <a href="#" @click.prevent="goToRoom(selected)">
                {{ selected.building_short }} · {{ selected.floor_number }} этаж ·
                каб. {{ selected.room_number }}
              </a>
            </dd>
          </template>

          <template v-if="selected.department_name">
            <dt>Отделение</dt>
            <dd>{{ selected.department_name }}</dd>
          </template>

          <dt>Подключено устройств</dt>
          <dd class="mono">{{ selected.devices_count || 0 }}</dd>

          <template v-if="selected.vlan">
            <dt>VLAN</dt><dd class="mono">{{ selected.vlan }}</dd>
          </template>
        </dl>

        <div class="field" style="margin-top:14px">
          <label class="eyebrow">Примечание</label>
          <textarea class="textarea" v-model="selected.notes"></textarea>
        </div>

        <template #footer>
          <button class="btn" @click="selected = null">Закрыть</button>
          <button class="btn btn--primary" @click="saveNotes">Сохранить</button>
        </template>
      </Modal>
    </div>
  `,

  setup() {
    const meta = useMetaStore();
    const toasts = useToastStore();
    const router = useRouter();

    const switches = ref([]);
    const loading = ref(true);
    const selected = ref(null);

    async function load() {
      loading.value = true;
      try {
        switches.value = (await networkApi.switches()).switches;
      } catch (err) {
        toasts.error(err.message);
      } finally {
        loading.value = false;
      }
    }
    onMounted(load);

    function switchOf(port) {
      return switches.value.find((s) => s.id === port.switch_id);
    }

    function portTitle(port) {
      const parts = [
        'Порт ' + port.port_number,
        meta.portStatuses[port.status]?.label,
      ];
      if (port.socket_label) parts.push('розетка ' + port.socket_label);
      if (port.room_number) parts.push('каб. ' + port.room_number);
      return parts.filter(Boolean).join(' · ');
    }

    async function saveStatus() {
      try {
        await networkApi.updatePort(selected.value.id, { status: selected.value.status });
        await load();
        // Восстанавливаем выделение после перезагрузки списка
        const fresh = switches.value
          .flatMap((s) => s.ports).find((p) => p.id === selected.value.id);
        if (fresh) selected.value = fresh;
        toasts.ok('Статус порта обновлён');
      } catch (err) {
        toasts.error(err.message);
      }
    }

    async function saveNotes() {
      try {
        await networkApi.updatePort(selected.value.id, {
          notes: selected.value.notes, vlan: selected.value.vlan,
        });
        toasts.ok('Сохранено');
        selected.value = null;
        await load();
      } catch (err) {
        toasts.error(err.message);
      }
    }

    function goToRoom(port) {
      selected.value = null;
      router.push({ path: '/map', query: { floor: port.floor_id, room: port.room_id } });
    }

    return { meta, switches, loading, selected, load, switchOf, portTitle, saveStatus, saveNotes, goToRoom };
  },
};

export default TopologyView;
