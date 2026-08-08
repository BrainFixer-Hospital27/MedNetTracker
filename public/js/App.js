import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore, useMetaStore } from './stores/core.js';
import { useMapStore } from './stores/map.js';
import SearchBox from './components/SearchBox.js';
import { Toasts } from './components/ui.js';
import { Icon } from './components/icons.js';

const NAV = [
  { to: '/map',      icon: 'map',      label: 'Карта' },
  { to: '/registry', icon: 'table',    label: 'Реестр' },
  { to: '/topology', icon: 'server',   label: 'Топология Cisco' },
  { to: '/admin',    icon: 'settings', label: 'Администрирование' },
];

export const App = {
  components: { SearchBox, Toasts, Icon },

  template: `
    <!-- Экран входа показывается без оболочки -->
    <template v-if="isLoginRoute">
      <router-view />
      <Toasts />
    </template>

    <div v-else class="shell">
      <nav class="rail">
        <div class="rail__logo" title="MedNet Tracker">
          <svg width="24" height="24" viewBox="0 0 32 32" fill="none"
               stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <path d="M16 6v7M16 19v7M7 16h18" />
            <circle cx="16" cy="16" r="3" />
          </svg>
        </div>

        <button v-for="item in nav" :key="item.to"
                class="rail__btn" :class="{ 'is-active': isActive(item.to) }"
                @click="go(item.to)">
          <Icon :name="item.icon" :size="19" />
          <span class="tip">{{ item.label }}</span>
        </button>

        <div class="rail__spacer"></div>

        <button class="rail__btn" @click="logout">
          <Icon name="logout" :size="19" />
          <span class="tip">Выйти ({{ auth.user?.username }})</span>
        </button>
      </nav>

      <div class="main">
        <header class="topbar">
          <span class="topbar__title">{{ pageTitle }}</span>

          <!-- Выбор корпуса и этажа: только на карте -->
          <template v-if="isMapRoute">
            <select class="select" style="width:auto;min-width:150px"
                    v-model.number="currentBuildingId">
              <option v-for="b in meta.buildings" :key="b.id" :value="b.id">{{ b.name }}</option>
            </select>
            <select class="select" style="width:auto;min-width:120px"
                    v-model.number="currentFloorId">
              <option v-for="f in currentFloors" :key="f.id" :value="f.id">
                {{ f.floor_number }} этаж
              </option>
            </select>
            <span v-if="mapStore.loading" class="pager__info">загрузка…</span>
          </template>

          <div class="topbar__spacer"></div>
          <SearchBox ref="searchRef" @go="onSearchGo" />
        </header>

        <main class="workspace">
          <router-view />
        </main>
      </div>

      <Toasts />
    </div>
  `,

  setup() {
    const auth = useAuthStore();
    const meta = useMetaStore();
    const mapStore = useMapStore();
    const route = useRoute();
    const router = useRouter();
    const searchRef = ref(null);

    const isLoginRoute = computed(() => route.path === '/login');
    const isMapRoute = computed(() => route.path === '/map');

    const pageTitle = computed(() =>
      NAV.find((item) => route.path.startsWith(item.to))?.label || 'MedNet Tracker'
    );

    function isActive(path) { return route.path.startsWith(path); }
    function go(path) { if (!isActive(path)) router.push(path); }

    async function logout() {
      await auth.logout();
      router.replace('/login');
    }

    // --- Выбор корпуса и этажа -------------------------------------

    const currentBuildingId = ref(null);

    const currentFloors = computed(() => {
      const building = meta.buildings.find((b) => b.id === currentBuildingId.value);
      return building ? building.floors || [] : [];
    });

    const currentFloorId = computed({
      get: () => mapStore.floorId,
      set: (id) => {
        if (id && id !== mapStore.floorId) {
          router.push({ path: '/map', query: { floor: id } });
        }
      },
    });

    // Корпус подтягивается за этажом, а не наоборот
    watch(() => mapStore.floorId, (id) => {
      const floor = meta.floorsById.get(id);
      if (floor) currentBuildingId.value = floor.building_id;
    }, { immediate: true });

    // Смена корпуса переводит на его первый этаж
    watch(currentBuildingId, (id, prev) => {
      if (!prev || !id || id === prev) return;
      const floors = meta.buildings.find((b) => b.id === id)?.floors || [];
      if (floors.length) currentFloorId.value = floors[0].id;
    });

    // --- Переход по результату поиска ------------------------------

    function onSearchGo(item) {
      const target = item.goto;
      const query = { floor: target.floor_id };
      if (target.device_id) query.device = target.device_id;
      else if (target.socket_id) query.socket = target.socket_id;
      else if (target.room_id) query.room = target.room_id;
      router.push({ path: '/map', query });
    }

    // --- Горячие клавиши -------------------------------------------

    function onKeyDown(event) {
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.value?.focus();
        return;
      }
      if (event.key === '/' && !inField) {
        event.preventDefault();
        searchRef.value?.focus();
      }
    }

    onMounted(() => document.addEventListener('keydown', onKeyDown));
    onBeforeUnmount(() => document.removeEventListener('keydown', onKeyDown));

    return {
      auth, meta, mapStore, nav: NAV, searchRef,
      isLoginRoute, isMapRoute, pageTitle,
      isActive, go, logout,
      currentBuildingId, currentFloors, currentFloorId, onSearchGo,
    };
  },
};

export default App;
