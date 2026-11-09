<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  vault, refreshVault, initVault, unlockVault, lockVault, putVaultItem, deleteVaultItem,
  clearVaultMessages, VAULT_NAME_PATTERN, VAULT_MAX_VALUE_BYTES, VAULT_MIN_PASSPHRASE,
} from '../stores/vault'

/**
 * 凭据保管库（R5 t15）。
 *
 * 三个状态必须一眼分得清（这也是本轮反复出现的教训：**"看起来没坏"比坏更危险**）：
 *   未初始化 → 引导设口令（并明确写清"丢了不可恢复"）
 *   已锁     → 只有一个口令框，列表**不显示**（锁定态连 hint 都不给）
 *   已解锁   → 列表 + 新增/替换/删除
 *
 * 明文边界（前端这一侧）：表单里的 value 只存在组件局部状态，保存成功后**立即清空**；
 * 列表永远只显示服务端给的 hint（后 4 位 + 长度）。界面上不存在"显示原值"的入口 ——
 * 不是没做，是产品上不允许（见 docs/vault-保管库.md）。
 */

// ── 未初始化：建库 ──────────────────────────────────────────────
const initPass = ref('')
const initPass2 = ref('')
const initErr = ref('')

// ── 已锁：解锁 ──────────────────────────────────────────────────
const unlockPass = ref('')

// ── 新增 ────────────────────────────────────────────────────────
const newName = ref('')
const newValue = ref('')
const showNewValue = ref(false)
const formErr = ref('')

// ── 替换（行内）─────────────────────────────────────────────────
const editing = ref('')
const editValue = ref('')
const showEditValue = ref(false)

// ── 删除二次确认（不做 window.confirm：阻塞式弹窗在面板里体验很差）──
const confirmingDelete = ref('')

const initialized = computed(() => vault.status?.initialized === true)
const unlocked = computed(() => initialized.value && vault.status?.locked === false)
const count = computed(() => vault.status?.count ?? 0)

/**
 * ★ T31 / W-1：当前是不是被 `MC_VAULT_PASSPHRASE` 自动解锁的。
 *
 * 这种状态下「上锁」是**假动作**：锁上之后，下一次读 secret（或下次 spawn agent）
 * 又会通过环境变量自动解开 —— 行为我们按用户决定不改，但按钮必须置灰并说清原因，
 * 否则运维会以为"我已经锁上了"，这比不给按钮更糟。
 */
const envUnlocked = computed(() => vault.status?.unlockSource === 'env')

function time(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function validateName(name: string): string {
  if (!name) return '名字不能为空，例如 OPENAI_API_KEY'
  if (!VAULT_NAME_PATTERN.test(name)) return '名字必须匹配 ^[A-Z][A-Z0-9_]{2,63}$（大写字母开头，可含数字与下划线）'
  return ''
}

function validateValue(value: string): string {
  if (!value) return '值不能为空'
  if (value.length > VAULT_MAX_VALUE_BYTES) return `值不能超过 ${VAULT_MAX_VALUE_BYTES} 个字符`
  if (/[\u0000-\u001f\u007f]/.test(value)) return '值里有换行或控制字符（复制时常见尾部带换行），请检查'
  return ''
}

async function doInit() {
  initErr.value = ''
  if (initPass.value.length < VAULT_MIN_PASSPHRASE) {
    initErr.value = `口令至少 ${VAULT_MIN_PASSPHRASE} 个字符`
    return
  }
  if (initPass.value !== initPass2.value) {
    initErr.value = '两次输入的口令不一致'
    return
  }
  try {
    await initVault(initPass.value)
    initPass.value = ''
    initPass2.value = ''
  } catch {
    /* 错误已在 store 里给出，页面用 vault.error 展示 */
  }
}

async function doUnlock() {
  try {
    await unlockVault(unlockPass.value)
    unlockPass.value = ''
  } catch {
    /* 同上 */
  }
}

async function doLock() {
  editing.value = ''
  editValue.value = ''
  confirmingDelete.value = ''
  await lockVault()
}

async function doCreate() {
  formErr.value = ''
  const name = newName.value.trim().toUpperCase()
  const bad = validateName(name) || validateValue(newValue.value)
  if (bad) {
    formErr.value = bad
    return
  }
  try {
    await putVaultItem(name, newValue.value)
    // 保存成功立刻清空：嘴上说"不可查看"，手里还留着明文副本就是自相矛盾
    newName.value = ''
    newValue.value = ''
    showNewValue.value = false
  } catch {
    /* store 已给错误 */
  }
}

function startEdit(name: string) {
  clearVaultMessages()
  confirmingDelete.value = ''
  editing.value = name
  editValue.value = ''
  showEditValue.value = false
}

function cancelEdit() {
  editing.value = ''
  editValue.value = ''
  showEditValue.value = false
}

async function doReplace(name: string) {
  formErr.value = ''
  const bad = validateValue(editValue.value)
  if (bad) {
    formErr.value = bad
    return
  }
  try {
    await putVaultItem(name, editValue.value)
    cancelEdit()
  } catch {
    /* store 已给错误 */
  }
}

async function doDelete(name: string) {
  if (confirmingDelete.value !== name) {
    confirmingDelete.value = name
    return
  }
  confirmingDelete.value = ''
  try {
    await deleteVaultItem(name)
  } catch {
    /* store 已给错误 */
  }
}

onMounted(() => {
  void refreshVault()
})
</script>

<template>
  <div class="vault scroll">
    <section class="panel">
      <div class="panel-title">
        凭据保管库
        <span class="faint small">· AES-256-GCM · scrypt · sqlite（把 keys.json 的明文搬进加密库）</span>
      </div>

      <div class="body">
        <!-- 状态条 -->
        <div class="row status">
          <span class="badge" :class="unlocked ? 'ok' : initialized ? 'warn' : 'bad'">
            {{ !initialized ? '未初始化' : unlocked ? '已解锁' : '已锁定' }}
          </span>
          <span class="faint small">共 {{ count }} 项</span>
          <span class="faint small" v-if="initialized">kdf = {{ vault.status?.kdf }}</span>
          <span v-if="unlocked" class="faint small">
            解锁来源：{{ envUnlocked ? '环境变量（MC_VAULT_PASSPHRASE）' : '手动输入口令' }}
          </span>
          <div class="spacer" />
          <button :disabled="vault.busy" @click="refreshVault">刷新</button>
          <!-- ★ W-1：env 自动解锁时「上锁」无效（下次读 secret 又会解开），所以置灰并给出原因 -->
          <button
            v-if="unlocked"
            :disabled="vault.busy || envUnlocked"
            :title="envUnlocked ? '当前由环境变量自动解锁，上锁对本进程无效' : ''"
            @click="doLock"
          >上锁</button>
        </div>

        <div v-if="envUnlocked" class="msg warn">
          当前由环境变量 <code>MC_VAULT_PASSPHRASE</code> 自动解锁，<strong>上锁对本进程无效</strong>
          —— 锁上之后下一次读取密钥会再次自动解开。要真正关闭，请移除该环境变量并重启 mindserver。
        </div>

        <div v-if="vault.error" class="msg bad">{{ vault.error }}</div>
        <div v-if="vault.notice" class="msg ok">{{ vault.notice }}</div>

        <!-- ① 未初始化 -->
        <div v-if="!initialized" class="block">
          <p class="hint">
            第一次使用要先设一个<strong>主口令</strong>。它不会存进任何地方 ——
            系统只用它派生出解密密钥（scrypt）。
          </p>
          <p class="hint warn-text">
            ⚠ 口令<strong>丢了不可恢复</strong>：库里的 API Key 再也解不开，只能删库重新录入。
            请把它记在离线的地方（密码管理器 / 纸上）。
          </p>
          <div class="form">
            <label class="field">
              <span>主口令（≥{{ VAULT_MIN_PASSPHRASE }} 位）</span>
              <input
                type="password"
                v-model="initPass"
                autocomplete="new-password"
                placeholder="设一个只有你知道的长口令"
              />
            </label>
            <label class="field">
              <span>再输一次</span>
              <input type="password" v-model="initPass2" autocomplete="new-password" />
            </label>
            <div class="row">
              <button class="primary" :disabled="vault.busy" @click="doInit">创建保管库</button>
              <span v-if="initErr" class="bad small">{{ initErr }}</span>
            </div>
          </div>
        </div>

        <!-- ② 已锁 -->
        <div v-else-if="!unlocked" class="block">
          <p class="hint">
            保管库已锁定。解锁后密钥只留在内存里，并注入到新起的 agent 子进程环境；
            <strong>锁定态下列表不显示</strong>（连 hint 都不给）。
          </p>
          <div class="form">
            <label class="field">
              <span>主口令</span>
              <input
                type="password"
                v-model="unlockPass"
                autocomplete="current-password"
                @keyup.enter="doUnlock"
              />
            </label>
            <div class="row">
              <button class="primary" :disabled="vault.busy" @click="doUnlock">解锁</button>
              <span class="faint small">连续错 5 次会被限流 60 秒</span>
            </div>
          </div>
        </div>

        <!-- ③ 已解锁 -->
        <div v-else class="block">
          <p class="warn-line">值写入后<strong>不可查看</strong>，只能替换。</p>

          <!-- 新增 -->
          <div class="form add">
            <label class="field">
              <span>名字</span>
              <input
                v-model="newName"
                placeholder="OPENAI_API_KEY"
                spellcheck="false"
                autocapitalize="characters"
              />
            </label>
            <label class="field grow">
              <span>值</span>
              <div class="row">
                <input
                  class="grow"
                  :type="showNewValue ? 'text' : 'password'"
                  v-model="newValue"
                  placeholder="粘贴 API key（保存后只留后 4 位）"
                  autocomplete="off"
                  spellcheck="false"
                />
                <button type="button" @click="showNewValue = !showNewValue">
                  {{ showNewValue ? '隐藏' : '显示' }}
                </button>
              </div>
            </label>
            <div class="row">
              <button class="primary" :disabled="vault.busy" @click="doCreate">保存</button>
              <span v-if="formErr" class="bad small">{{ formErr }}</span>
              <span v-else class="faint small">同名即替换（旧值不可回看）</span>
            </div>
          </div>

          <!-- 列表 -->
          <div class="list">
            <div class="list-head row">
              <span class="c-name">名字</span>
              <span class="c-hint">掩码</span>
              <span class="c-time">更新时间</span>
              <span class="c-by">来源</span>
              <span class="c-act">操作</span>
            </div>

            <div v-for="it in vault.items" :key="it.name" class="item">
              <div class="row item-row">
                <span class="c-name mono">{{ it.name }}</span>
                <span class="c-hint mono hint">{{ it.hint }}</span>
                <span class="c-time faint small num">{{ time(it.updatedAt) }}</span>
                <span class="c-by faint small">{{ it.updatedBy || '-' }}</span>
                <span class="c-act row">
                  <button :disabled="vault.busy" @click="startEdit(it.name)">替换</button>
                  <button
                    class="danger"
                    :disabled="vault.busy"
                    @click="doDelete(it.name)"
                  >{{ confirmingDelete === it.name ? '确认删除？' : '删除' }}</button>
                </span>
              </div>

              <!-- 行内替换：整值替换，不预填旧值（旧值根本不在前端） -->
              <div v-if="editing === it.name" class="row replace">
                <input
                  class="grow"
                  :type="showEditValue ? 'text' : 'password'"
                  v-model="editValue"
                  placeholder="输入新的值（旧的不会被显示）"
                  autocomplete="off"
                  spellcheck="false"
                  @keyup.enter="doReplace(it.name)"
                />
                <button type="button" @click="showEditValue = !showEditValue">
                  {{ showEditValue ? '隐藏' : '显示' }}
                </button>
                <button class="primary" :disabled="vault.busy" @click="doReplace(it.name)">替换</button>
                <button :disabled="vault.busy" @click="cancelEdit">取消</button>
              </div>
            </div>

            <div v-if="!vault.items.length" class="faint small pad">
              还没有任何条目。上面填一个名字和值就能存进去。
            </div>
          </div>

          <p class="hint">
            这些密钥会被注入到<strong>新起的</strong> agent 子进程环境变量里（不写盘）。
            已经跑着的 agent 要重启才会拿到新密钥；<code>node main.js</code> 单进程直跑时
            由 <code>src/utils/keys.js</code> 直接读保管库。
          </p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.vault { padding: var(--gap); height: 100%; overflow: auto; }
.body { padding: 12px; display: flex; flex-direction: column; gap: 12px; }

.status { gap: 10px; }
.spacer { flex: 1; }

.msg { font-size: 12px; padding: 6px 10px; border-radius: 6px; }
.msg.bad { color: var(--bad); background: #261212; border: 1px solid #4a2a2a; }
.msg.ok { color: var(--ok); background: #12261a; border: 1px solid #2a4a2f; }
/* T31 / W-1：环境变量自动解锁的说明条（警示级，不是错误） */
.msg.warn { color: var(--warn); background: #26200f; border: 1px solid #4a3f1f; }
.msg code { background: var(--bg-hover); padding: 0 4px; border-radius: 3px; }

.block { display: flex; flex-direction: column; gap: 10px; }
.hint { font-size: 12px; color: var(--fg-dim); line-height: 1.7; margin: 0; }
.hint code {
  background: var(--bg-hover);
  padding: 0 4px; border-radius: 3px;
}
.warn-text { color: var(--warn); }
.warn-line {
  margin: 0; font-size: 12px; color: var(--warn);
  background: #26200f; border: 1px solid #4a3f1f; border-radius: 6px; padding: 6px 10px;
}

.form { display: flex; flex-direction: column; gap: 8px; }
.form.add { border-bottom: 1px solid var(--border-soft); padding-bottom: 12px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--fg-dim); }
.field input { margin-top: 2px; }
.grow { flex: 1; min-width: 0; }

.list { display: flex; flex-direction: column; }
.list-head {
  font-size: 11px; color: var(--fg-faint); text-transform: uppercase;
  letter-spacing: .06em; padding: 4px 6px; border-bottom: 1px solid var(--border-soft);
}
.item { border-bottom: 1px solid var(--border-soft); }
.item-row { padding: 6px; }
.item:hover .item-row { background: var(--bg-hover); border-radius: 6px; }

.c-name { flex: 0 0 220px; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.c-hint { flex: 0 0 160px; }
.c-time { flex: 0 0 130px; }
.c-by { flex: 0 0 90px; }
.c-act { flex: 1; justify-content: flex-end; }
.mono { font-family: var(--mono); font-size: 12px; }
.c-hint.hint { color: var(--fg-dim); }

.replace { padding: 6px; background: var(--bg-elev); border-radius: 6px; gap: 6px; }
.pad { padding: 8px; }
.small { font-size: 11px; }
</style>
