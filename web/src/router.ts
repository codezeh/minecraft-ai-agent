import { createRouter, createWebHistory } from 'vue-router'
import ConsoleView from './views/ConsoleView.vue'

export const router = createRouter({
  // dev 时 BASE_URL 为 '/'，prod 由 vite 的 base 注入成 '/console/'
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'console', component: ConsoleView, meta: { label: '控制台' } },
    {
      path: '/terrain',
      name: 'terrain',
      component: () => import('./views/TerrainView.vue'),
      meta: { label: '3D 地形' },
    },
    {
      path: '/debug',
      name: 'debug',
      component: () => import('./views/DebugView.vue'),
      meta: { label: '诊断' },
    },
    {
      path: '/setup',
      name: 'setup',
      component: () => import('./views/SetupView.vue'),
      meta: { label: '配置' },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
