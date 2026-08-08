import { ref, computed, watch, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { deviceApi, structureApi } from '../api.js';
import { useMetaStore, useToastStore } from '../stores/core.js';
import { DeviceForm } from '../components/forms.js';
import { Icon, DeviceGlyph } from '../components/icons.js';
import { deviceTitle, roomTitle } from '../labels.js';

/**
 * Реестр: плоская таблица всего оборудования с фильтрами.
 * Отсюда же делается выгрузка в CSV - ровно с теми фильтрами,
 * что сейчас применены, чтобы не выгружать лишнее.
 */
export const RegistryView = {
  components: { DeviceForm, Icon, DeviceGlyph },

  template: `
    <div class="page">
      <div class="page__head">
        <h1 class="page__title">Реестр оборудования</h1>
        <span class="badge">{{ total }} записей</span>
        <div style="flex:1"></div>
        <button class="btn" @click="newDevice">
          <Icon name="plus" :size="14" /> Добавить
        </button>
        <a class="btn" :href="exportUrl" download>
          <Icon name="download" :size="14" /> Выгрузить CSV
        </a>
      </div>

      <div class="toolbar">
        <input class="input" style="min-width:210px" v-model="filters.q"
               placeholder="Поиск по номеру, MAC, модели…">

        <select class="select" v-model="filters.building_id">
          <option value="">Все корпуса</option>
          <option v-for="b in meta.buildings" :key="b.id" :value="b.id">{{ b.name }}</option>
        </select>

        <select class="select" v-model="filters.floor_id">
          <option value="">Все этажи</option>
          <option v-for="f in floorOptions" :key="f.id" :value="f.id">
            {{ f.building.short_name }} · {{ f.floor_number }} этаж
          </option>
        </select>

        <select class="select" v-model="filters.department_id">
          <option value="">Все отделения</option>
          <option v-for="d in meta.departments" :key="d.id" :value="d.id">{{ d.name }}</option>
        </select>

        <select class="select" v-model="filters.type">
          <option value="">Все типы</option>
          <optgroup v-for="layer in meta.layers" :key="layer.key" :label="layer.label">
            <option v-for="t in (meta.typesByLayer[layer.key] || [])" :key="t.key" :value="t.key">
              {{ t.label }}
            </option>
          </optgroup>
        </select>

        <select class="select" v-model="filters.status">
          <option value="">Любое состояние</option>
          <option v-for="(info, key) in meta.deviceStatuses" :key="key" :value="key">
            {{ info.label }}
          </option>
        </select>

        <select class="select" v-model="filters.connected">
          <option value="">Связь: любая</option>
          <option value="yes">Подключено</option>
          <option value="no">Без подключения</option>
        </select>

        <button class="btn btn--ghost btn--sm" @click="resetFilters">Сбросить</button>
      </div>

      <div class="table-wrap">
        <table class="grid">
          <thead>
            <tr>
              <th :class="thClass('inventory_number')" @click="sortBy('inventory_number')">Инв. номер</th>
              <th :class="thClass('type')" @click="sortBy('type')">Тип</th>
              <th>Наименование</th>
              <th :class="thClass('room')" @click="sortBy('room')">Кабинет</th>
              <th :class="thClass('department')" @click="sortBy('department')">Отделение</th>
              <th>Подключение</th>
              <th :class="thClass('responsible')" @click="sortBy('responsible')">Ответственный</th>
              <th :class="thClass('status')" @click="sortBy('status')">Состояние</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="device in devices" :key="device.id"
                @click="edit(device.id)" style="cursor:pointer">
              <td class="num">{{ device.inventory_number || '—' }}</td>
              <td>
                <span style="display:inline-flex;align-items:center;gap:6px">
                  <DeviceGlyph :glyph="device.icon" :size="13"
                               :style="{ color: meta.layerColor(device.layer) }" />
                  {{ device.type_label }}
                </span>
              </td>
              <td>{{ title(device) }}</td>
              <td class="num">
                <a v-if="device.room_id" href="#" @click.stop.prevent="showOnMap(device)"
                   :title="device.room_name || ''">
                  {{ device.room_number }}
                </a>
                <span v-else style="color:var(--muted)">склад</span>
              </td>
              <td>{{ device.department_name || '—' }}</td>
              <td style="font-size:12.5px">{{ connection(device) }}</td>
              <td>{{ device.responsible_person || '—' }}</td>
              <td>
                <span class="badge" :style="{ color: meta.statusColor(device.status) }">
                  <i class="badge__dot"></i>{{ meta.statusLabel(device.status) }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!loading && !devices.length" class="table-empty">
          Ничего не найдено. Попробуйте ослабить фильтры.
        </div>
        <div v-if="loading" class="table-empty">Загружаем…</div>
      </div>

      <div class="pager">
        <button class="btn btn--sm" :disabled="page <= 1" @click="page--">
          <Icon name="chevronLeft" :size="13" /> Назад
        </button>
        <span class="pager__info">Страница {{ page }} из {{ pages }}</span>
        <button class="btn btn--sm" :disabled="page >= pages" @click="page++">
          Вперёд <Icon name="chevronRight" :size="13" />
        </button>
        <select class="select btn--sm" style="width:auto;margin-left:8px" v-model.number="perPage">
          <option :value="25">25 на странице</option>
          <option :value="50">50</option>
          <option :value="100">100</option>
          <option :value="200">200</option>
        </select>
      </div>

      <DeviceForm v-if="form.open" :key="'r' + (form.id || 'new')"
                  :device-id="form.id"
                  @saved="onSaved" @deleted="onSaved" @close="form.open = false" />
    </div>
  `,

  setup() {
    const meta = useMetaStore();
    const toasts = useToastStore();
    const router = useRouter();

    const devices = ref([]);
    const total = ref(0);
    const pages = ref(1);
    const page = ref(1);
    const perPage = ref(50);
    const loading = ref(false);
    const sort = ref({ key: 'inventory_number', dir: 'asc' });
    const form = ref({ open: false, id: null });

    const blankFilters = () => ({
      q: '', building_id: '', floor_id: '', department_id: '',
      type: '', status: '', connected: '',
    });
    const filters = ref(blankFilters());

    const floorOptions = computed(() => {
      const list = [...meta.floorsById.values()];
      const buildingId = Number(filters.value.building_id) || null;
      return list
        .filter((f) => !buildingId || f.building_id === buildingId)
        .sort((a, b) => a.building_id - b.building_id || a.floor_number - b.floor_number);
    });

    const query = computed(() => ({
      ...filters.value,
      page: page.value,
      per_page: perPage.value,
      sort: sort.value.key,
      dir: sort.value.dir,
    }));

    const exportUrl = computed(() => deviceApi.exportUrl(filters.value));

    let debounce = null;
    watch(query, () => {
      clearTimeout(debounce);
      debounce = setTimeout(load, 180);
    }, { deep: true });

    // Смена фильтров возвращает на первую страницу
    watch(filters, () => { page.value = 1; }, { deep: true });

    async function load() {
      loading.value = true;
      try {
        const data = await deviceApi.list(query.value);
        devices.value = data.devices;
        total.value = data.total;
        pages.value = data.pages;
      } catch (err) {
        toasts.error(err.message);
      } finally {
        loading.value = false;
      }
    }

    onMounted(load);

    function sortBy(key) {
      if (sort.value.key === key) {
        sort.value = { key, dir: sort.value.dir === 'asc' ? 'desc' : 'asc' };
      } else {
        sort.value = { key, dir: 'asc' };
      }
    }

    function thClass(key) {
      return { 'is-sorted': sort.value.key === key };
    }

    function resetFilters() {
      filters.value = blankFilters();
    }

    function connection(d) {
      const uplink = d.uplink;
      if (!uplink || uplink.kind === 'none') return 'не подключено';
      if (uplink.kind === 'socket') {
        return 'розетка ' + (d.uplink_socket_label || '');
      }
      const label = d.uplink_device_name || d.uplink_device_model || 'устройство';
      const medium = meta.media[uplink.medium]?.label || '';
      return label + (medium ? ' · ' + medium : '');
    }

    function edit(id) {
      form.value = { open: true, id: Number(id) };
    }

    function newDevice() {
      form.value = { open: true, id: null };
    }

    async function onSaved() {
      form.value = { open: false, id: null };
      await load();
    }

    function showOnMap(device) {
      router.push({ path: '/map', query: { floor: device.floor_id, device: device.id } });
    }

    return {
      meta, devices, total, pages, page, perPage, loading, filters, sort, form,
      floorOptions, exportUrl,
      sortBy, thClass, resetFilters, title: deviceTitle, connection, edit, newDevice, onSaved, showOnMap,
    };
  },
};

export default RegistryView;
