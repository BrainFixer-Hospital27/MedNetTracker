import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useToastStore } from '../stores/core.js';
import { Icon } from './icons.js';

/** Модальное окно. Закрывается по Escape и щелчку по подложке. */
export const Modal = {
  components: { Icon },
  props: {
    title: { type: String, default: '' },
    wide: { type: Boolean, default: false },
  },
  emits: ['close'],
  template: `
    <div class="modal-backdrop" @pointerdown.self="$emit('close')">
      <div class="modal" :class="{ 'modal--wide': wide }" role="dialog" aria-modal="true">
        <div class="modal__head">
          <h3 class="modal__title">{{ title }}</h3>
          <button class="modal__close" type="button" @click="$emit('close')" aria-label="Закрыть">
            <Icon name="close" :size="15" />
          </button>
        </div>
        <div class="modal__body"><slot /></div>
        <div class="modal__foot"><slot name="footer" /></div>
      </div>
    </div>
  `,
  setup(props, { emit }) {
    function onKey(event) { if (event.key === 'Escape') emit('close'); }
    onMounted(() => document.addEventListener('keydown', onKey));
    onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
  },
};

/** Всплывающие уведомления. */
export const Toasts = {
  template: `
    <div class="toasts">
      <div v-for="toast in toasts.items" :key="toast.id"
           class="toast" :class="'toast--' + toast.kind"
           @click="toasts.dismiss(toast.id)">
        {{ toast.message }}
      </div>
    </div>
  `,
  setup() {
    return { toasts: useToastStore() };
  },
};

/**
 * Поле пароля с раскрытием по нажатию на «глазок».
 * Содержимое само прячется обратно через несколько секунд, чтобы
 * пароль не остался на экране в кабинете с посетителями.
 */
export const SecretInput = {
  components: { Icon },
  props: {
    modelValue: { type: String, default: '' },
    placeholder: { type: String, default: '' },
    hideAfter: { type: Number, default: 8000 },
  },
  emits: ['update:modelValue'],
  template: `
    <div class="secret">
      <input class="input" :type="visible ? 'text' : 'password'"
             :value="modelValue" :placeholder="placeholder"
             autocomplete="off" spellcheck="false"
             @input="$emit('update:modelValue', $event.target.value)">
      <button type="button" class="secret__eye" @click="toggle"
              :title="visible ? 'Скрыть' : 'Показать'">
        <Icon :name="visible ? 'eyeOff' : 'eye'" :size="15" />
      </button>
    </div>
  `,
  setup(props) {
    const visible = ref(false);
    let timer = null;
    function toggle() {
      visible.value = !visible.value;
      clearTimeout(timer);
      if (visible.value) timer = setTimeout(() => { visible.value = false; }, props.hideAfter);
    }
    onBeforeUnmount(() => clearTimeout(timer));
    return { visible, toggle };
  },
};

/** Диалог подтверждения. */
export const ConfirmDialog = {
  components: { Modal },
  props: {
    title: { type: String, default: 'Подтверждение' },
    message: { type: String, required: true },
    confirmLabel: { type: String, default: 'Подтвердить' },
    danger: { type: Boolean, default: false },
  },
  emits: ['confirm', 'cancel'],
  template: `
    <Modal :title="title" @close="$emit('cancel')">
      <p style="margin:0">{{ message }}</p>
      <template #footer>
        <button class="btn" @click="$emit('cancel')">Отмена</button>
        <button class="btn" :class="danger ? 'btn--danger' : 'btn--primary'"
                @click="$emit('confirm')">{{ confirmLabel }}</button>
      </template>
    </Modal>
  `,
};

export default { Modal, Toasts, SecretInput, ConfirmDialog };
