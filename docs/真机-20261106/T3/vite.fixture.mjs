// T3 夹具构建配置（不是产品代码）。
// 从 web/ 目录跑：  npx vite build --config <本文件>
// 目的：把 docs/T3/fixture/{current,old} 编成一个 base=/console/ 的单页产物，
//   之后由 CDP 的 Fetch.fulfillRequest 挂到 http://localhost:8080/console 上（同源 ⇒ cookie/socket 都真实）。
// vue / @vitejs/plugin-vue 直接从 web/node_modules 绝对路径加载：夹具在 web/ 之外，裸包名解析不到。
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const WEB = 'E:/我的世界ai/web'
const T3 = 'E:/我的世界ai/docs/真机-20261106/T3'

export default async () => {
  const { default: vue } = await import(pathToFileURL(path.join(WEB, 'node_modules/@vitejs/plugin-vue/dist/index.mjs')).href)
  const variant = (process.env.T3_VARIANT || 'current').trim() === 'old' ? 'old' : 'current'
  return {
    root: path.join(T3, 'fixture', variant),
    base: '/console/',
    plugins: [vue()],
    // 夹具只 import 产品源码 + vue；vue 必须和 web/src 里解析到**同一个模块实例**，否则
    // ChatStream 的响应式与夹具不是同一份 Vue。
    resolve: {
      alias: [
        { find: /^vue$/, replacement: path.join(WEB, 'node_modules/vue/dist/vue.runtime.esm-bundler.js') },
      ],
    },
    define: { __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
    logLevel: 'info',
    build: {
      outDir: path.join(T3, `dist-${variant}`),
      emptyOutDir: true,
      minify: true,
      rollupOptions: { output: { entryFileNames: 'assets/t3-[name]-[hash].js', chunkFileNames: 'assets/t3-[name]-[hash].js', assetFileNames: 'assets/t3-[name]-[hash][extname]' } },
    },
  }
}
