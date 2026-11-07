// T4 夹具专用：**原型级只读探针**。
// 通过 vite alias 把 'three' 映射到本文件：所有导出原样透传真 three（同一个模块实例），
// 只在 `WebGLRenderer.prototype.render` 上包一层，用来记录
//   · 真正在渲染的那个实例（不管调用方用的是哪个类引用）
//   · 每次 render 的 scene/camera ⇒ 可遍历 InstancedMesh 读容量/count/包围球/矩阵
// 为什么不用子类：实测子类实例没被真正用于渲染（组件里 new 出来的不是它）⇒ 改用原型 patch，
// 这样"谁在渲染"就一定能抓到，而且完全不改变行为/类型。
//
// 只存在于 docs/真机-20261106/T4/，不进 web/src。
import * as REAL from 'E:/我的世界ai/web/node_modules/three/build/three.module.js'

export * from 'E:/我的世界ai/web/node_modules/three/build/three.module.js'

const W = () => {
  const w: any = window as any
  if (!w.__t4) {
    w.__t4 = {
      renderers: [],
      renders: 0,
      lastScene: null,
      lastCamera: null,
      glErrors: [],
      contextLost: 0,
      contexts: [],
      patched: false,
    }
  }
  return w.__t4
}

const t4 = W()
if (!t4.patched) {
  const proto: any = (REAL as any).WebGLRenderer.prototype
  const origRender = proto.render
  proto.render = function (scene: any, camera: any) {
    const s = W()
    if (s.renderers.indexOf(this) < 0) {
      s.renderers.push(this)
      try {
        const gl = this.getContext()
        if (s.contexts.indexOf(gl) < 0) s.contexts.push(gl)
        this.domElement?.addEventListener?.('webglcontextlost', () => { s.contextLost++ })
      } catch (e) { s.glErrors.push('getContext: ' + String(e)) }
    }
    s.renders++
    s.lastScene = scene
    s.lastCamera = camera
    return origRender.call(this, scene, camera)
  }
  const origDispose = proto.dispose
  proto.dispose = function () {
    const s = W()
    s.disposed = (s.disposed || 0) + 1
    return origDispose.call(this)
  }
  t4.patched = true
}
