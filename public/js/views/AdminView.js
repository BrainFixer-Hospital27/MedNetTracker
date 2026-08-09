import { ref, computed, onMounted } from 'vue';
import { structureApi, mapApi, authApi, networkApi, reportApi } from '../api.js';
import { useMetaStore, useToastStore } from '../stores/core.js';
import { useMapStore } from '../stores/map.js';
import { Modal } from '../components/ui.js';
import { Icon } from '../components/icons.js';

// =====================================================================
//  Подготовка файла плана на стороне браузера
// =====================================================================

/**
 * Приводит выгруженный из редактора SVG к контракту приложения.
 *
 * Разбор делает встроенный DOMParser - на сервере отдельный парсер XML
 * не нужен. Здесь же снимаются инлайновые заливки с фигур помещений:
 * иначе они перебьют раскраску по отделениям.
 *
 * @returns {{svg: string, width: number, height: number, ids: string[]}}
 */
function prepareSvg(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Файл не удалось разобрать: это не корректный SVG');
  }
  const root = doc.querySelector('svg');
  if (!root) throw new Error('В файле нет корневого элемента <svg>');

  // viewBox обязателен: без него неизвестна система координат
  let viewBox = root.getAttribute('viewBox');
  if (!viewBox) {
    const w = parseFloat(root.getAttribute('width'));
    const h = parseFloat(root.getAttribute('height'));
    if (!w || !h) {
      throw new Error('У корневого <svg> нет ни viewBox, ни размеров width/height');
    }
    viewBox = `0 0 ${w} ${h}`;
    root.setAttribute('viewBox', viewBox);
  }
  const [, , vw, vh] = viewBox.trim().split(/[\s,]+/).map(Number);

  const shapes = [...root.querySelectorAll('[id^="room-"]')];
  if (!shapes.length) {
    throw new Error(
      'Не найдено ни одной фигуры с id вида room-XXX. ' +
      'Проверьте, что в Inkscape при сохранении выключено сокращение идентификаторов.'
    );
  }

  const ids = [];
  for (const el of shapes) {
    ids.push(el.id);
    el.classList.add('room');
    el.style.removeProperty('fill');
    el.style.removeProperty('fill-opacity');
    el.removeAttribute('fill');
    if (!el.getAttribute('style')) el.removeAttribute('style');
  }

  // Фиксированные размеры мешают вписывать план в холст
  root.removeAttribute('width');
  root.removeAttribute('height');

  return {
    svg: new XMLSerializer().serializeToString(root),
    width: vw, height: vh, ids,
  };
}

// =====================================================================

export const AdminView = {
  components: { Modal, Icon },

  template: `
    <div class="page">
      <div class="page__head">
        <h1 class="page__title">Администрирование</h1>
        <div style="flex:1"></div>
        <button class="btn btn--sm" :class="{ 'btn--primary': tab === 'plans' }"
                @click="tab = 'plans'">Планы этажей</button>
        <button class="btn btn--sm" :class="{ 'btn--primary': tab === 'structure' }"
                @click="tab = 'structure'">Структура</button>
        <button class="btn btn--sm" :class="{ 'btn--primary': tab === 'network' }"
                @click="tab = 'network'">Коммутаторы</button>
        <button class="btn btn--sm" :class="{ 'btn--primary': tab === 'reports' }"
                @click="tab = 'reports'">Отчёты</button>
        <button class="btn btn--sm" :class="{ 'btn--primary': tab === 'account' }"
                @click="tab = 'account'">Учётная запись</button>
      </div>

      <!-- ==================== Сводка ==================== -->
      <div v-if="stats" class="cards" style="margin-bottom:18px">
        <div class="card">
          <div class="card__value">{{ stats.devices }}</div>
          <div class="card__label">единиц оборудования</div>
          <div v-if="stats.devices_unconnected" class="card__note">
            без подключения: {{ stats.devices_unconnected }}
          </div>
        </div>
        <div class="card">
          <div class="card__value">{{ stats.rooms }}</div>
          <div class="card__label">помещений</div>
          <div v-if="stats.rooms_unmapped" class="card__note">
            не привязано к плану: {{ stats.rooms_unmapped }}
          </div>
        </div>
        <div class="card">
          <div class="card__value">{{ stats.sockets }}</div>
          <div class="card__label">розеток</div>
          <div v-if="stats.sockets_no_port" class="card__note">
            без линии до Cisco: {{ stats.sockets_no_port }}
          </div>
        </div>
        <div class="card">
          <div class="card__value">{{ stats.ports_active }} / {{ stats.ports_total }}</div>
          <div class="card__label">портов Cisco занято</div>
        </div>
      </div>

      <!-- ==================== Нарушения целостности ==================== -->
      <div v-if="integrity.length" class="note note--warn" style="margin-bottom:18px">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <Icon name="warning" :size="15" />
          <b>Найдено связей, нарушающих правила совместимости: {{ integrity.length }}</b>
          <div style="flex:1"></div>
          <button class="btn btn--sm" @click="showIntegrity = !showIntegrity">
            {{ showIntegrity ? 'Свернуть' : 'Показать' }}
          </button>
          <button class="btn btn--sm btn--danger" @click="repairIntegrity">
            Разорвать недопустимые связи
          </button>
        </div>
        <ul v-if="showIntegrity" class="list-plain" style="margin-top:10px">
          <li v-for="item in integrity" :key="item.kind + item.id">
            <span class="mono">#{{ item.id }}</span>
            <span class="grow">{{ item.title }}<span v-if="item.room_number">
              · каб. {{ item.room_number }}</span></span>
            <span style="font-size:12px">{{ item.reason }}</span>
          </li>
        </ul>
        <p style="margin:8px 0 0;font-size:12px">
          Оборудование сохранится — пропадёт только подключение,
          которого физически не может существовать.
        </p>
      </div>

      <!-- ==================== Планы этажей ==================== -->
      <template v-if="tab === 'plans'">
        <div class="toolbar">
          <select class="select" style="min-width:230px" v-model.number="selectedFloorId"
                  @change="loadBindings">
            <optgroup v-for="b in meta.buildings" :key="b.id" :label="b.name">
              <option v-for="f in b.floors" :key="f.id" :value="f.id">
                {{ f.floor_number }} этаж
                {{ f.svg_file ? '— план загружен' : '— плана нет' }}
              </option>
            </optgroup>
          </select>
          <span class="pager__info" v-if="bindings">
            фигур в файле: {{ bindings.total_in_svg }}
          </span>
          <div style="flex:1"></div>
          <button class="btn btn--sm" :disabled="!selectedFloorId" @click="resetPositions">
            <Icon name="refresh" :size="13" /> Разместить заново
          </button>
        </div>

        <div class="split">
          <div>
            <div class="dropzone" :class="{ 'is-over': dragOver }"
                 @click="$refs.fileInput.click()"
                 @dragover.prevent="dragOver = true"
                 @dragleave="dragOver = false"
                 @drop.prevent="onDrop">
              <Icon name="upload" :size="22" style="margin-bottom:6px" />
              <div>Перетащите сюда файл SVG или нажмите для выбора</div>
              <div style="font-size:12px;margin-top:5px">
                Нужны: viewBox у корневого тега и фигуры с id вида
                <span class="mono">room-214</span>
              </div>
            </div>
            <input ref="fileInput" type="file" accept=".svg,image/svg+xml"
                   style="display:none" @change="onFilePicked">

            <div v-if="uploadState" class="note" style="margin-top:12px"
                 :class="uploadState.kind === 'error' ? 'note--danger' : 'note--ok'">
              {{ uploadState.message }}
            </div>
            <div v-if="uploadWarning" class="note note--warn" style="margin-top:10px">
              <Icon name="warning" :size="13" style="vertical-align:-2px" />
              {{ uploadWarning }}
            </div>

            <div v-if="bindings?.id_hint" class="note" style="margin-top:12px">
              Идентификаторы фигур для этого этажа:
              <span class="mono">{{ bindings.id_hint }}</span> для кабинета,
              <span class="mono">{{ bindings.id_hint_corridor }}</span> для коридора.
              Короткая форма <span class="mono">room-214</span> тоже принимается.
            </div>
          </div>

          <div v-if="bindings">
            <div class="section">
              <span class="eyebrow">Привязано — {{ bindings.bound.length }}</span>
              <ul class="list-plain" style="max-height:180px;overflow:auto">
                <li v-for="room in bindings.bound" :key="room.id">
                  <span class="mono grow">{{ room.room_number }}</span>
                  <span class="mono" style="color:var(--muted);font-size:12px">
                    {{ room.svg_polygon_id }}
                  </span>
                </li>
              </ul>
            </div>

            <div v-if="bindings.unmatched.length" class="section">
              <span class="eyebrow" style="color:var(--warn)">
                Фигуры без помещения — {{ bindings.unmatched.length }}
              </span>
              <p style="font-size:12.5px;color:var(--muted);margin:0 0 8px">
                Для них не нашлось записи с таким номером. Можно создать
                помещения автоматически или привязать вручную.
              </p>
              <ul class="list-plain">
                <li v-for="item in bindings.unmatched" :key="item.svg_polygon_id">
                  <span class="mono grow">{{ item.svg_polygon_id }}</span>
                  <select class="select btn--sm" style="width:auto"
                          @change="bindManual(item.svg_polygon_id, $event.target.value)">
                    <option value="">— выбрать помещение —</option>
                    <option v-for="room in bindings.missing" :key="room.id" :value="room.id">
                      {{ room.room_number }}
                    </option>
                  </select>
                </li>
              </ul>
              <button class="btn btn--sm" style="margin-top:8px" @click="createFromSvg">
                <Icon name="plus" :size="13" />
                Создать помещения по номерам из плана
              </button>
            </div>

            <div v-if="bindings.missing.length" class="section">
              <span class="eyebrow">Помещения без фигуры — {{ bindings.missing.length }}</span>
              <ul class="list-plain" style="max-height:150px;overflow:auto">
                <li v-for="room in bindings.missing" :key="room.id">
                  <span class="mono grow">{{ room.room_number }}</span>
                  <span style="color:var(--muted);font-size:12px">не будет видно на карте</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </template>

      <!-- ==================== Структура ==================== -->
      <template v-else-if="tab === 'structure'">
        <div class="split">
          <section>
            <div class="page__head">
              <h2 class="page__title" style="font-size:15px">Корпуса и этажи</h2>
              <button class="btn btn--sm" @click="newBuilding">
                <Icon name="plus" :size="13" /> Корпус
              </button>
            </div>

            <div v-for="b in meta.buildings" :key="b.id" class="card" style="margin-bottom:10px">
              <div style="display:flex;align-items:center;gap:8px">
                <div class="grow" style="flex:1">
                  <div style="font-weight:600">{{ b.name }}</div>
                  <div style="color:var(--muted);font-size:12px">
                    {{ b.short_name }}{{ b.address ? ' · ' + b.address : '' }}
                  </div>
                </div>
                <button class="btn btn--sm btn--ghost" @click="editBuilding(b)">
                  <Icon name="edit" :size="13" />
                </button>
              </div>
              <ul class="list-plain" style="margin-top:8px">
                <li v-for="f in b.floors" :key="f.id">
                  <span class="mono">{{ f.floor_number }} этаж</span>
                  <span class="grow" style="color:var(--muted);font-size:12px">
                    {{ f.rooms_count }} помещений{{ f.svg_file ? '' : ' · плана нет' }}
                  </span>
                  <button class="btn btn--sm btn--ghost" title="Удалить этаж"
                          @click="removeFloor(f)">
                    <Icon name="trash" :size="12" />
                  </button>
                </li>
              </ul>
              <button class="btn btn--sm" style="margin-top:8px" @click="newFloor(b)">
                <Icon name="plus" :size="12" /> Добавить этаж
              </button>
            </div>
          </section>

          <section>
            <div class="page__head">
              <h2 class="page__title" style="font-size:15px">Отделения</h2>
              <button class="btn btn--sm" @click="newDepartment">
                <Icon name="plus" :size="13" /> Отделение
              </button>
            </div>
            <ul class="list-plain">
              <li v-for="d in meta.departments" :key="d.id">
                <i class="color-dot" :style="{ background: d.color }"></i>
                <div class="grow">
                  <div>{{ d.name }}</div>
                  <div style="color:var(--muted);font-size:12px">
                    {{ d.head_person || 'ответственный не указан' }} ·
                    {{ d.rooms_count }} помещ. · {{ d.devices_count }} устр.
                  </div>
                </div>
                <button class="btn btn--sm btn--ghost" @click="editDepartment(d)">
                  <Icon name="edit" :size="13" />
                </button>
              </li>
            </ul>
          </section>
        </div>
      </template>

      <!-- ==================== Коммутаторы ==================== -->
      <template v-else-if="tab === 'network'">
        <div class="page__head">
          <h2 class="page__title" style="font-size:15px">Коммутаторы Cisco</h2>
          <button class="btn btn--sm" @click="newSwitch">
            <Icon name="plus" :size="13" /> Коммутатор
          </button>
        </div>
        <ul class="list-plain">
          <li v-for="sw in switches" :key="sw.id">
            <div class="grow">
              <span class="mono" style="font-weight:600">{{ sw.name }}</span>
              <span style="color:var(--muted);font-size:12px">
                · {{ sw.model }} · {{ sw.ip_address }} ·
                портов {{ sw.total_ports }}, занято {{ sw.used }}
              </span>
            </div>
            <button class="btn btn--sm btn--ghost" @click="editSwitch(sw)">
              <Icon name="edit" :size="13" />
            </button>
          </li>
        </ul>
      </template>

      <!-- ==================== Отчёты ==================== -->
      <template v-else-if="tab === 'reports'">
        <!-- Охват задаётся один раз и действует на все выгрузки: без
             него в большой организации любой отчёт нечитаем -->
        <div class="toolbar">
          <span class="eyebrow">Охват</span>
          <select class="select" v-model="scope.building_id" @change="scope.floor_id = ''">
            <option value="">Вся организация</option>
            <option v-for="b in meta.buildings" :key="b.id" :value="b.id">{{ b.name }}</option>
          </select>
          <select class="select" v-model="scope.floor_id" :disabled="!scope.building_id">
            <option value="">Все этажи</option>
            <option v-for="f in scopeFloors" :key="f.id" :value="f.id">{{ f.floor_number }} этаж</option>
          </select>
          <select class="select" v-model="scope.department_id">
            <option value="">Все отделения</option>
            <option v-for="d in meta.departments" :key="d.id" :value="d.id">{{ d.name }}</option>
          </select>
          <span class="eyebrow" style="margin-left:10px">Период журнала</span>
          <input class="input" type="date" style="width:auto" v-model="scope.from">
          <input class="input" type="date" style="width:auto" v-model="scope.to">
          <button class="btn btn--ghost btn--sm" @click="resetScope">Сбросить</button>
        </div>

        <div class="cards" style="margin-bottom:18px">
          <div class="card">
            <div class="eyebrow" style="margin-bottom:8px">Всё сразу</div>
            <p style="margin:0 0 10px;font-size:12.5px;color:var(--text-dim)">
              Книга Excel: по листу на каждый отчёт, с автофильтром
              и закреплённой шапкой.
            </p>
            <a class="btn btn--primary" :href="workbookUrl" download>
              <Icon name="download" :size="14" /> Скачать книгу XLSX
            </a>
          </div>
          <div class="card">
            <div class="eyebrow" style="margin-bottom:8px">Для доклада</div>
            <p style="margin:0 0 10px;font-size:12.5px;color:var(--text-dim)">
              Печатная сводка одной страницей. Сохраняется в PDF
              командой браузера «Печать».
            </p>
            <a class="btn" :href="summaryUrl" target="_blank" rel="noopener">
              <Icon name="table" :size="14" /> Открыть сводку
            </a>
          </div>
          <div class="card">
            <div class="eyebrow" style="margin-bottom:8px">Динамика</div>
            <p style="margin:0 0 10px;font-size:12.5px;color:var(--text-dim)">
              Срезов накоплено: <b class="mono">{{ snapshotCount }}</b>.
              Снимаются сами раз в месяц.
            </p>
            <button class="btn" @click="takeSnapshot">
              <Icon name="refresh" :size="14" /> Снять срез сейчас
            </button>
          </div>
        </div>

        <div v-for="group in reportGroups" :key="group.name" style="margin-bottom:18px">
          <div class="eyebrow" style="margin-bottom:8px">{{ group.name }}</div>
          <ul class="list-plain">
            <li v-for="item in group.items" :key="item.key">
              <div class="grow">
                <div>{{ item.title }}</div>
                <div style="color:var(--muted);font-size:12px">{{ item.description }}</div>
              </div>
              <button class="btn btn--sm btn--ghost" @click="preview(item.key)">
                Посмотреть
              </button>
              <a class="btn btn--sm" :href="csvUrl(item.key)" download>
                <Icon name="download" :size="12" /> CSV
              </a>
            </li>
          </ul>
        </div>
      </template>

      <!-- ==================== Учётная запись ==================== -->
      <template v-else>
        <div class="card" style="max-width:420px">
          <div class="eyebrow" style="margin-bottom:10px">Смена пароля</div>
          <div class="field">
            <label class="eyebrow">Текущий пароль</label>
            <input class="input" type="password" v-model="pw.current" autocomplete="current-password">
          </div>
          <div class="field">
            <label class="eyebrow">Новый пароль</label>
            <input class="input" type="password" v-model="pw.next" autocomplete="new-password">
          </div>
          <div class="field">
            <label class="eyebrow">Повторите новый пароль</label>
            <input class="input" type="password" v-model="pw.repeat" autocomplete="new-password">
          </div>
          <button class="btn btn--primary" @click="changePassword"
                  :disabled="!pw.current || pw.next.length < 8 || pw.next !== pw.repeat">
            Сменить пароль
          </button>
          <p style="color:var(--muted);font-size:12px;margin:10px 0 0">
            Не короче 8 символов. В базе хранится только хеш.
          </p>
        </div>
      </template>

      <!-- Предпросмотр отчёта -->
      <Modal v-if="previewData" :title="previewData.title" wide @close="previewData = null">
        <p v-if="previewData.note" class="note" style="margin:0 0 12px">{{ previewData.note }}</p>
        <p style="margin:0 0 10px;color:var(--muted);font-size:12.5px">
          Всего строк: <b class="mono">{{ previewData.total }}</b>.
          Ниже первые {{ previewData.rows.length }}.
        </p>
        <div class="table-wrap" style="max-height:52vh">
          <table class="grid">
            <thead><tr><th v-for="c in previewData.columns" :key="c.key">{{ c.title }}</th></tr></thead>
            <tbody>
              <tr v-for="(row, i) in previewData.rows" :key="i">
                <td v-for="c in previewData.columns" :key="c.key"
                    :class="{ num: c.type === 'integer' || c.type === 'number' }">
                  {{ row[c.key] }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <template #footer>
          <a class="btn btn--primary" :href="csvUrl(previewData.key)" download>
            <Icon name="download" :size="13" /> Выгрузить CSV
          </a>
          <button class="btn" @click="previewData = null">Закрыть</button>
        </template>
      </Modal>

      <!-- ==================== Универсальный редактор ==================== -->
      <Modal v-if="editor" :title="editor.title" @close="editor = null">
        <div v-for="field in editor.fields" :key="field.key" class="field">
          <label class="eyebrow">{{ field.label }}</label>
          <input v-if="field.type === 'color'" class="input" type="color"
                 v-model="editor.data[field.key]" style="height:34px;padding:2px">
          <input v-else-if="field.type === 'number'" class="input mono" type="number"
                 v-model.number="editor.data[field.key]">
          <input v-else class="input" :class="{ mono: field.mono }"
                 v-model="editor.data[field.key]">
        </div>
        <template #footer>
          <button v-if="editor.onDelete" class="btn btn--danger" style="margin-right:auto"
                  @click="editor.onDelete()">
            <Icon name="trash" :size="13" /> Удалить
          </button>
          <button class="btn" @click="editor = null">Отмена</button>
          <button class="btn btn--primary" @click="editor.onSave()">Сохранить</button>
        </template>
      </Modal>
    </div>
  `,

  setup() {
    const meta = useMetaStore();
    const mapStore = useMapStore();
    const toasts = useToastStore();

    const tab = ref('plans');
    const stats = ref(null);
    const switches = ref([]);
    const editor = ref(null);
    const dragOver = ref(false);
    const uploadState = ref(null);
    const uploadWarning = ref(null);
    const bindings = ref(null);
    const selectedFloorId = ref(null);
    const pw = ref({ current: '', next: '', repeat: '' });
    const integrity = ref([]);
    const showIntegrity = ref(false);

    // --- Отчёты ---
    const reportList = ref([]);
    const snapshotCount = ref(0);
    const previewData = ref(null);
    const blankScope = () => ({
      building_id: '', floor_id: '', department_id: '', from: '', to: '',
    });
    const scope = ref(blankScope());

    const scopeFloors = computed(() => {
      const building = meta.buildings.find((b) => b.id === Number(scope.value.building_id));
      return building ? building.floors || [] : [];
    });

    /** Отбрасывает пустые значения, чтобы не тащить их в адрес. */
    const cleanScope = computed(() => {
      const out = {};
      for (const [key, value] of Object.entries(scope.value)) if (value) out[key] = value;
      return out;
    });

    const reportGroups = computed(() => {
      const groups = [];
      for (const item of reportList.value) {
        let group = groups.find((g) => g.name === item.group);
        if (!group) { group = { name: item.group, items: [] }; groups.push(group); }
        group.items.push(item);
      }
      return groups;
    });

    const workbookUrl = computed(() => reportApi.workbookUrl(cleanScope.value));
    const summaryUrl = computed(() => reportApi.summaryUrl(cleanScope.value));
    const csvUrl = (key) => reportApi.exportUrl(key, cleanScope.value);

    function resetScope() { scope.value = blankScope(); }

    async function preview(key) {
      try {
        const data = await reportApi.preview(key, cleanScope.value);
        previewData.value = { ...data, key };
      } catch (err) {
        toasts.error(err.message);
      }
    }

    async function takeSnapshot() {
      try {
        const result = await reportApi.takeSnapshot();
        toasts.ok(result.updated
          ? `Срез за ${result.period} обновлён`
          : `Снят срез за ${result.period}`);
        snapshotCount.value = (await reportApi.list()).snapshots.length;
      } catch (err) {
        toasts.error(err.message);
      }
    }

    // =================================================================
    //  Начальная загрузка
    // =================================================================
    async function loadAll() {
      try {
        const [statsData, switchData, integrityData] = await Promise.all([
          mapApi.stats(), networkApi.switches(), mapApi.integrity(),
        ]);
        stats.value = statsData;
        switches.value = switchData.switches;
        integrity.value = integrityData.problems;
        const reportData = await reportApi.list();
        reportList.value = reportData.reports;
        snapshotCount.value = reportData.snapshots.length;
      } catch (err) {
        toasts.error(err.message);
      }
      if (!selectedFloorId.value) {
        const first = meta.buildings.find((b) => (b.floors || []).length);
        selectedFloorId.value = first ? first.floors[0].id : null;
      }
      if (selectedFloorId.value) loadBindings();
    }
    onMounted(loadAll);

    async function loadBindings() {
      if (!selectedFloorId.value) return;
      try {
        bindings.value = await structureApi.bindings(selectedFloorId.value);
      } catch (err) {
        toasts.error(err.message);
      }
    }

    // =================================================================
    //  Загрузка плана
    // =================================================================
    function onDrop(event) {
      dragOver.value = false;
      const file = event.dataTransfer.files?.[0];
      if (file) uploadFile(file);
    }

    function onFilePicked(event) {
      const file = event.target.files?.[0];
      if (file) uploadFile(file);
      event.target.value = '';
    }

    async function uploadFile(file) {
      if (!selectedFloorId.value) {
        toasts.error('Сначала выберите этаж');
        return;
      }
      uploadState.value = null;
      uploadWarning.value = null;
      try {
        const text = await file.text();
        const prepared = prepareSvg(text);
        const report = await structureApi.uploadSvg(selectedFloorId.value, {
          svg: prepared.svg, width: prepared.width, height: prepared.height,
        });

        bindings.value = report;
        uploadWarning.value = report.warning || null;
        uploadState.value = {
          kind: 'ok',
          message: `План принят. Фигур: ${report.total_in_svg}, ` +
            `привязано автоматически: ${report.bound.length}` +
            (report.unmatched.length ? `, без пары: ${report.unmatched.length}` : ''),
        };
        toasts.ok('План этажа загружен');

        await meta.reloadStructure();
        // Если открыт тот же этаж на карте - перечитаем его
        if (mapStore.floorId === selectedFloorId.value) {
          mapStore.svgText = '';
          await mapStore.loadFloor(selectedFloorId.value);
        }
        stats.value = await mapApi.stats();
      } catch (err) {
        uploadState.value = { kind: 'error', message: err.message };
      }
    }

    /** Заново разложить оборудование по кабинетам этажа. */
    async function resetPositions() {
      if (!window.confirm(
        'Сбросить расстановку оборудования на этом этаже? ' +
        'Иконки разложатся по кабинетам заново при следующем открытии карты.'
      )) return;
      try {
        const result = await structureApi.resetPositions(selectedFloorId.value);
        toasts.ok(`Сброшено: ${result.devices} устройств, ${result.sockets} розеток`);
        if (mapStore.floorId === selectedFloorId.value) await mapStore.refresh();
      } catch (err) {
        toasts.error(err.message);
      }
    }

    async function bindManual(polygonId, roomId) {
      if (!roomId) return;
      try {
        await structureApi.bind(selectedFloorId.value, polygonId, Number(roomId));
        await loadBindings();
        toasts.ok('Привязка сохранена');
      } catch (err) {
        toasts.error(err.message);
      }
    }

    async function createFromSvg() {
      const items = (bindings.value?.unmatched || []).map((item) => ({
        svg_polygon_id: item.svg_polygon_id,
        room_number: item.suggested_number,
      }));
      if (!items.length) return;
      try {
        const result = await structureApi.createRoomsFromSvg(selectedFloorId.value, items);
        toasts.ok(`Создано помещений: ${result.created.length}`);
        await loadBindings();
        await meta.reloadStructure();
        stats.value = await mapApi.stats();
      } catch (err) {
        toasts.error(err.message);
      }
    }

    // =================================================================
    //  Редакторы справочников
    // =================================================================
    function openEditor(config) { editor.value = config; }

    function newBuilding() {
      openEditor({
        title: 'Новый корпус',
        data: { name: '', short_name: '', address: '' },
        fields: [
          { key: 'name', label: 'Название' },
          { key: 'short_name', label: 'Сокращение', mono: true },
          { key: 'address', label: 'Адрес' },
        ],
        onSave: async () => {
          try {
            await structureApi.createBuilding(editor.value.data);
            await meta.reloadStructure();
            editor.value = null;
            toasts.ok('Корпус добавлен');
          } catch (err) { toasts.error(err.message); }
        },
      });
    }

    function editBuilding(building) {
      openEditor({
        title: 'Корпус',
        data: { ...building },
        fields: [
          { key: 'name', label: 'Название' },
          { key: 'short_name', label: 'Сокращение', mono: true },
          { key: 'address', label: 'Адрес' },
          { key: 'sort_order', label: 'Порядок', type: 'number' },
        ],
        onSave: async () => {
          try {
            await structureApi.updateBuilding(building.id, editor.value.data);
            await meta.reloadStructure();
            editor.value = null;
            toasts.ok('Сохранено');
          } catch (err) { toasts.error(err.message); }
        },
        onDelete: async () => {
          if (!window.confirm('Удалить корпус «' + building.name + '»?')) return;
          try {
            await structureApi.deleteBuilding(building.id);
            await meta.reloadStructure();
            editor.value = null;
            toasts.ok('Корпус удалён');
          } catch (err) { toasts.error(err.message); }
        },
      });
    }

    function newFloor(building) {
      const next = Math.max(0, ...(building.floors || []).map((f) => f.floor_number)) + 1;
      openEditor({
        title: 'Новый этаж — ' + building.name,
        data: { building_id: building.id, floor_number: next, name: '' },
        fields: [
          { key: 'floor_number', label: 'Номер этажа', type: 'number' },
          { key: 'name', label: 'Название (необязательно)' },
        ],
        onSave: async () => {
          try {
            await structureApi.createFloor(editor.value.data);
            await meta.reloadStructure();
            editor.value = null;
            toasts.ok('Этаж добавлен');
          } catch (err) { toasts.error(err.message); }
        },
      });
    }

    async function removeFloor(floor) {
      if (!window.confirm('Удалить ' + floor.floor_number + ' этаж?')) return;
      try {
        await structureApi.deleteFloor(floor.id);
        await meta.reloadStructure();
        toasts.ok('Этаж удалён');
      } catch (err) { toasts.error(err.message); }
    }

    function newDepartment() {
      openEditor({
        title: 'Новое отделение',
        data: { name: '', head_person: '', phone: '', color: '#8b95a5' },
        fields: [
          { key: 'name', label: 'Название' },
          { key: 'head_person', label: 'Ответственный' },
          { key: 'phone', label: 'Телефон', mono: true },
          { key: 'color', label: 'Цвет на карте', type: 'color' },
        ],
        onSave: async () => {
          try {
            await structureApi.createDepartment(editor.value.data);
            await meta.reloadStructure();
            editor.value = null;
            toasts.ok('Отделение добавлено');
          } catch (err) { toasts.error(err.message); }
        },
      });
    }

    function editDepartment(dept) {
      openEditor({
        title: 'Отделение',
        data: { ...dept },
        fields: [
          { key: 'name', label: 'Название' },
          { key: 'head_person', label: 'Ответственный' },
          { key: 'phone', label: 'Телефон', mono: true },
          { key: 'color', label: 'Цвет на карте', type: 'color' },
        ],
        onSave: async () => {
          try {
            await structureApi.updateDepartment(dept.id, editor.value.data);
            await meta.reloadStructure();
            editor.value = null;
            toasts.ok('Сохранено');
          } catch (err) { toasts.error(err.message); }
        },
        onDelete: async () => {
          if (!window.confirm(
            'Удалить отделение «' + dept.name + '»? Помещения останутся, но потеряют привязку.'
          )) return;
          try {
            await structureApi.deleteDepartment(dept.id);
            await meta.reloadStructure();
            editor.value = null;
            toasts.ok('Отделение удалено');
          } catch (err) { toasts.error(err.message); }
        },
      });
    }

    function newSwitch() {
      openEditor({
        title: 'Новый коммутатор',
        data: { name: '', model: 'Cisco Catalyst 2960', ip_address: '', total_ports: 24, location: '' },
        fields: [
          { key: 'name', label: 'Название', mono: true },
          { key: 'model', label: 'Модель' },
          { key: 'ip_address', label: 'IP-адрес', mono: true },
          { key: 'total_ports', label: 'Число портов', type: 'number' },
          { key: 'location', label: 'Расположение' },
        ],
        onSave: async () => {
          try {
            await networkApi.createSwitch(editor.value.data);
            switches.value = (await networkApi.switches()).switches;
            editor.value = null;
            toasts.ok('Коммутатор добавлен');
          } catch (err) { toasts.error(err.message); }
        },
      });
    }

    function editSwitch(sw) {
      openEditor({
        title: 'Коммутатор ' + sw.name,
        data: { ...sw },
        fields: [
          { key: 'name', label: 'Название', mono: true },
          { key: 'model', label: 'Модель' },
          { key: 'ip_address', label: 'IP-адрес', mono: true },
          { key: 'total_ports', label: 'Число портов', type: 'number' },
          { key: 'location', label: 'Расположение' },
        ],
        onSave: async () => {
          try {
            await networkApi.updateSwitch(sw.id, editor.value.data);
            switches.value = (await networkApi.switches()).switches;
            editor.value = null;
            toasts.ok('Сохранено');
          } catch (err) { toasts.error(err.message); }
        },
        onDelete: async () => {
          if (!window.confirm('Удалить коммутатор ' + sw.name + '?')) return;
          try {
            await networkApi.deleteSwitch(sw.id);
            switches.value = (await networkApi.switches()).switches;
            editor.value = null;
            toasts.ok('Коммутатор удалён');
          } catch (err) { toasts.error(err.message); }
        },
      });
    }

    async function repairIntegrity() {
      if (!window.confirm(
        'Разорвать ' + integrity.value.length + ' недопустимых связей? ' +
        'Оборудование останется в учёте.'
      )) return;
      try {
        const result = await mapApi.repairIntegrity();
        toasts.ok('Разорвано связей: ' + result.detached);
        integrity.value = (await mapApi.integrity()).problems;
      } catch (err) {
        toasts.error(err.message);
      }
    }

    // =================================================================
    //  Смена пароля
    // =================================================================
    async function changePassword() {
      try {
        await authApi.changePassword(pw.value.current, pw.value.next);
        pw.value = { current: '', next: '', repeat: '' };
        toasts.ok('Пароль изменён');
      } catch (err) {
        toasts.error(err.message);
      }
    }

    return {
      meta, tab, stats, switches, editor, dragOver, uploadState, bindings,
      selectedFloorId, pw, integrity, showIntegrity, repairIntegrity,
      uploadWarning, resetPositions,
      scope, scopeFloors, reportGroups, workbookUrl, summaryUrl, csvUrl,
      snapshotCount, previewData, resetScope, preview, takeSnapshot,
      loadBindings, onDrop, onFilePicked, bindManual, createFromSvg,
      newBuilding, editBuilding, newFloor, removeFloor,
      newDepartment, editDepartment, newSwitch, editSwitch, changePassword,
    };
  },
};

export default AdminView;
