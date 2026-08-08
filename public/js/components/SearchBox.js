import { ref, watch, onBeforeUnmount } from 'vue';
import { mapApi } from '../api.js';
import { Icon } from './icons.js';

const KIND_LABELS = {
  device: 'Оборудование',
  room: 'Помещения',
  socket: 'Розетки',
  person: 'Сотрудники',
};

/**
 * Глобальный поиск. Ищет по инвентарному и серийному номерам, MAC,
 * IP, фамилии ответственного и номеру кабинета - одним полем, без
 * выбора «где искать».
 */
export const SearchBox = {
  components: { Icon },
  emits: ['go'],
  template: `
    <div class="search" ref="root">
      <Icon name="search" :size="15" class="search__icon" />
      <input ref="input" class="search__input" type="search"
             v-model="query" :placeholder="placeholder"
             autocomplete="off" spellcheck="false"
             @focus="open = true"
             @keydown.down.prevent="move(1)"
             @keydown.up.prevent="move(-1)"
             @keydown.enter.prevent="choose(results[cursor])"
             @keydown.esc="close">

      <div v-if="open && (results.length || query.length >= 2)" class="search__results">
        <div v-if="loading" class="search__empty">Ищем…</div>

        <template v-else-if="results.length">
          <template v-for="group in grouped" :key="group.kind">
            <div class="search__group eyebrow">{{ group.label }}</div>
            <div v-for="item in group.items" :key="item.kind + item.id"
                 class="search__item"
                 :class="{ 'is-active': results[cursor] === item }"
                 @pointerdown.prevent="choose(item)">
              <div style="min-width:0">
                <div class="search__item-title">{{ item.title }}</div>
                <div v-if="item.subtitle" class="search__item-sub">{{ item.subtitle }}</div>
              </div>
              <div v-if="item.place" class="search__item-place">{{ item.place }}</div>
            </div>
          </template>
        </template>

        <div v-else class="search__empty">
          Ничего не найдено по запросу «{{ query }}»
        </div>
      </div>
    </div>
  `,

  setup(props, { emit }) {
    const root = ref(null);
    const input = ref(null);
    const query = ref('');
    const results = ref([]);
    const grouped = ref([]);
    const loading = ref(false);
    const open = ref(false);
    const cursor = ref(0);

    const placeholder = 'Инвентарный номер, MAC, кабинет, фамилия…';

    let timer = null;
    let controller = null;

    watch(query, (value) => {
      clearTimeout(timer);
      controller?.abort();
      cursor.value = 0;

      if (value.trim().length < 2) {
        results.value = [];
        grouped.value = [];
        loading.value = false;
        return;
      }
      loading.value = true;
      open.value = true;
      timer = setTimeout(() => runSearch(value.trim()), 220);
    });

    async function runSearch(text) {
      controller = new AbortController();
      try {
        const data = await mapApi.search(text, { signal: controller.signal });
        results.value = data.results;
        grouped.value = groupResults(data.results);
      } catch (err) {
        if (err.name !== 'AbortError') {
          results.value = [];
          grouped.value = [];
        }
      } finally {
        loading.value = false;
      }
    }

    /** Раскладывает плоский список по разделам, сохраняя общий порядок. */
    function groupResults(items) {
      const order = ['device', 'room', 'socket', 'person'];
      return order
        .map((kind) => ({
          kind,
          label: KIND_LABELS[kind],
          items: items.filter((i) => i.kind === kind),
        }))
        .filter((g) => g.items.length);
    }

    function move(delta) {
      if (!results.value.length) return;
      open.value = true;
      cursor.value = (cursor.value + delta + results.value.length) % results.value.length;
    }

    function choose(item) {
      if (!item) return;
      if (item.kind === 'person') {
        query.value = item.title;   // уточняем запрос вместо перехода
        return;
      }
      emit('go', item);
      close();
    }

    function close() {
      open.value = false;
      input.value?.blur();
    }

    function onDocPointerDown(event) {
      if (root.value && !root.value.contains(event.target)) open.value = false;
    }

    /** Фокус по горячей клавише - вызывается из оболочки. */
    function focus() {
      input.value?.focus();
      input.value?.select();
    }

    document.addEventListener('pointerdown', onDocPointerDown);
    onBeforeUnmount(() => {
      document.removeEventListener('pointerdown', onDocPointerDown);
      clearTimeout(timer);
      controller?.abort();
    });

    return {
      root, input, query, results, grouped, loading, open, cursor,
      placeholder, move, choose, close, focus,
    };
  },
};

export default SearchBox;
