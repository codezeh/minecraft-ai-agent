import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// dev: 跑在 5173，socket.io 与贴图代理都转发到 mindserver(8080)
// prod: 产物 base=/console/，由 mindserver 静态托管
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/console/' : '/',
  plugins: [vue()],
  server: {
    port: 5173,
    strictPort: true,
    // poc/ 里跑脚本时会产生临时文件，vite 的 watcher 撞上会 EBUSY 并**把整个 dev server 带崩**
    // （实测踩过）。npm 缓存和构建产物同理，一并排除。
    watch: {
      // 踩过两次：编辑工具用 `<名字>.<pid>.<uuid>.tmpdir/` 做原子写，
      // vite 的 watcher 会去 watch 里面的 .tmp 文件 → EBUSY → 未捕获错误 → **整个 dev server 崩掉**。
      // 所以 dotfile、dot 目录、*.tmp 必须全部排除。
      ignored: [
        '**/.*',
        '**/.*/**',
        '**/*.tmp',
        '**/poc/**',
        '**/dist/**',
        '**/.npm-cache/**',
        '**/node_modules/**',
      ],
    },
    proxy: {
      // 必须写 127.0.0.1 而不是 localhost：mindserver 只绑 IPv4，
      // 而 Node 18+ 的 localhost 会优先解析成 ::1，导致 ECONNREFUSED（踩过）。
      '/socket.io': { target: 'http://127.0.0.1:8080', ws: true, changeOrigin: true },
      '/assets': { target: 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
}))
