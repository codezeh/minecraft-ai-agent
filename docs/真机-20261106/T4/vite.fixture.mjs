// T4 夹具构建（不是产品代码）。从 web/ 目录跑：npx vite build --config <本文件>
// 关键：把 'three' alias 到本目录的 three-instrument.ts（只包一层 WebGLRenderer 做只读观测），
// 其余 three 的导出原样透传，保证与产品代码同一模块实例。
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const WEB = 'E:/我的世界ai/web'
const T4 = 'E:/我的世界ai/docs/真机-20261106/T4'

export default async () => {
  const { default: vue } = await import(pathToFileURL(path.join(WEB, 'node_modules/@vitejs/plugin-vue/dist/index.mjs')).href)
  const variant = (process.env.T4_VARIANT || 'current').trim() === 'old' ? 'old' : 'current'
  return {
    root: path.join(T4, variant === 'old' ? 'fixture-old' : 'fixture'),
    base: '/console/',
    plugins: [vue()],
    resolve: {
      alias: [
        // 只替换裸 'three'；'three/addons/...' 仍走 node_modules（它内部 import 'three' 也会被这里接管）
        { find: /^three$/, replacement: path.join(T4, 'three-instrument.ts') },
        { find: /^vue$/, replacement: path.join(WEB, 'node_modules/vue/dist/vue.runtime.esm-bundler.js') },
      ],
    },
    define: {
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    logLevel: 'info',
    build: {
      outDir: path.join(T4, `dist-${variant}`),
      emptyOutDir: true,
      minify: true,
      chunkSizeWarningLimit: 3000,
      rollupOptions: { output: { entryFileNames: 'assets/t4-[name]-[hash].js', chunkFileNames: 'assets/t4-[name]-[hash].js', assetFileNames: 'assets/t4-[name]-[hash][extname]' } },
    },
  }
}
