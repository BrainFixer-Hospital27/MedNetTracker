import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';

import App from './App.js';
import LoginView from './views/LoginView.js';
import MapView from './views/MapView.js';
import RegistryView from './views/RegistryView.js';
import TopologyView from './views/TopologyView.js';
import AdminView from './views/AdminView.js';

import { useAuthStore, useMetaStore } from './stores/core.js';
import { onUnauthorized } from './api.js';

// ---------------------------------------------------------------------
//  Маршруты
// ---------------------------------------------------------------------
const routes = [
  { path: '/', redirect: '/map' },
  { path: '/login', component: LoginView, meta: { public: true } },
  { path: '/map', component: MapView },
  { path: '/registry', component: RegistryView },
  { path: '/topology', component: TopologyView },
  { path: '/admin', component: AdminView },
  // Неизвестные адреса ведут на карту, а не в пустоту
  { path: '/:pathMatch(.*)*', redirect: '/map' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

const app = createApp(App);
app.use(createPinia());
app.use(router);

const auth = useAuthStore();
const meta = useMetaStore();

/**
 * Защита маршрутов.
 * Первый переход проверяет сессию на сервере, дальше решение
 * принимается по уже известному состоянию - без лишних запросов.
 */
router.beforeEach(async (to) => {
  if (!auth.checked) await auth.check();

  if (!to.meta.public && !auth.isAuthenticated) {
    return { path: '/login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } };
  }
  if (to.meta.public && auth.isAuthenticated) {
    return { path: '/map' };
  }
  // Справочник нужен всем внутренним экранам
  if (!to.meta.public && !meta.loaded) {
    try {
      await meta.load();
    } catch {
      return { path: '/login' };
    }
  }
  return true;
});

// Сессия истекла в середине работы - возвращаем на форму входа
onUnauthorized(() => {
  if (router.currentRoute.value.path === '/login') return;
  auth.dropSession();
  router.replace({
    path: '/login',
    query: { redirect: router.currentRoute.value.fullPath },
  });
});

app.mount('#app');
