import { ref, computed } from 'vue';
import { useMapStore } from '../stores/map.js';
import { useMetaStore } from '../stores/core.js';
import { deviceTitle } from '../labels.js';
import { Icon, DeviceGlyph } from './icons.js';

/**
 * Полоса «Не размещено».
 *
 * Оборудование, не привязанное ни к какому помещению: склад, заказанное
 * и ещё не привезённое, запланированное к покупке. На карте его
 * показать негде - координаты отсчитываются от плана этажа, а этажа у
 * него нет. Поэтому оно живёт отдельной полосой, откуда его можно
 * перетащить прямо на план.
 */
export const UnplacedTray = {
  components: { Icon, DeviceGlyph },
  emits: ['drag-start', 'edit', 'add'],

  template: `
    <aside class="tray" :class="{ 'is-collapsed': !open }">
      <button type="button" class="tray__toggle" @click="open = !open"
              :title="open ? 'Свернуть' : 'Не размещённое оборудование'">
        <Icon name="layers" :size="14" />
        <span v-if="open" class="tray__toggle-text">Не размещено</span>
        <span class="tray__count" :class="{ 'is-zero': !items.length }">{{ items.length }}</span>
        <Icon v-if="open" name="chevronRight" :size="13" />
      </button>

      <template v-if="open">
        <div class="tray__body">
          <p v-if="!items.length" class="tray__empty">
            Всё оборудование размещено по кабинетам.
          </p>

          <div v-for="group in grouped" :key="group.key" class="tray__group">
            <div class="eyebrow" :style="{ color: group.color }">
              {{ group.label }} — {{ group.items.length }}
            </div>
            <div v-for="device in group.items" :key="device.id"
                 class="tray__item"
                 @pointerdown="$emit('drag-start', $event, device)"
                 @dblclick="$emit('edit', device.id)">
              <DeviceGlyph :glyph="device.icon" :size="14"
                           :style="{ color: meta.layerColor(device.layer) }" />
              <div class="tray__item-body">
                <div class="tray__item-title">{{ title(device) }}</div>
                <div class="tray__item-sub">
                  {{ device.type_label }}{{ device.inventory_number
                    ? ' · ' + device.inventory_number : '' }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="tray__foot">
          <button class="btn btn--sm" style="width:100%;justify-content:center"
                  @click="$emit('add')">
            <Icon name="plus" :size="13" /> Добавить
          </button>
          <p class="tray__hint">
            Перетащите иконку на план, чтобы разместить оборудование
            в кабинете.
          </p>
        </div>
      </template>
    </aside>
  `,

  setup() {
    const store = useMapStore();
    const meta = useMetaStore();
    const open = ref(false);

    const items = computed(() => store.unplaced);

    /** Группировка по состоянию: заказанное отдельно от складского. */
    const grouped = computed(() => {
      const order = ['planned', 'ordered', 'spare', 'repair', 'in_use', 'written_off'];
      return order
        .map((key) => ({
          key,
          label: meta.statusLabel(key),
          color: meta.statusColor(key),
          items: items.value.filter((d) => d.status === key),
        }))
        .filter((g) => g.items.length);
    });

    return { store, meta, open, items, grouped, title: deviceTitle };
  },
};

export default UnplacedTray;
