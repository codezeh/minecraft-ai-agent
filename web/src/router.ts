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
    // R5 t28：设置中心（网络/身份/备份/运行时四组，带开关与滑块）。
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./views/SettingsView.vue'),
      meta: { label: '设置' },
    },
    // #68：任务板（最小入口：看板 + 取消/重试）
    {
      path: '/board',
      name: 'board',
      component: () => import('./views/BoardView.vue'),
      meta: { label: '任务板' },
    },
    // R5 t15：凭据保管库（加密存 API Key）。懒加载，和其它二级页一致。
    {
      path: '/vault',
      name: 'vault',
      component: () => import('./views/VaultView.vue'),
      meta: { label: '凭据' },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
