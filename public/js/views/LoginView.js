import { ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '../stores/core.js';

export const LoginView = {
  template: `
    <div class="login">
      <form class="login__card" @submit.prevent="submit">
        <svg class="login__mark" width="34" height="34" viewBox="0 0 32 32" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M16 5v8M16 19v8M6 16h20" />
          <circle cx="16" cy="16" r="3.2" />
          <circle cx="6" cy="16" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="26" cy="16" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="16" cy="5" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="16" cy="27" r="1.6" fill="currentColor" stroke="none" />
        </svg>

        <h1 class="login__title">MedNet Tracker</h1>
        <p class="login__sub">Учёт сетевой инфраструктуры больницы</p>

        <div v-if="error" class="login__error">{{ error }}</div>

        <div class="field">
          <label class="eyebrow">Логин</label>
          <input ref="loginInput" class="input" v-model="username"
                 autocomplete="username" autocapitalize="none" spellcheck="false" required>
        </div>

        <div class="field">
          <label class="eyebrow">Пароль</label>
          <input class="input" type="password" v-model="password"
                 autocomplete="current-password" required>
        </div>

        <button class="btn btn--primary" type="submit"
                style="width:100%;justify-content:center;margin-top:6px"
                :disabled="busy || !username || !password">
          {{ busy ? 'Проверяем…' : 'Войти' }}
        </button>

        <p class="login__foot">
          Доступ к системе имеет только администратор.
          Логин и первичный пароль задаются в файле <span class="mono">.env</span>
          при развёртывании.
        </p>
      </form>
    </div>
  `,

  setup() {
    const auth = useAuthStore();
    const router = useRouter();
    const route = useRoute();

    const loginInput = ref(null);
    const username = ref('');
    const password = ref('');
    const error = ref('');
    const busy = ref(false);

    onMounted(() => loginInput.value?.focus());

    async function submit() {
      error.value = '';
      busy.value = true;
      try {
        await auth.login(username.value, password.value);
        const target = route.query.redirect || '/map';
        router.replace(target);
      } catch (err) {
        error.value = err.message;
        password.value = '';
      } finally {
        busy.value = false;
      }
    }

    return { loginInput, username, password, error, busy, submit };
  },
};

export default LoginView;
