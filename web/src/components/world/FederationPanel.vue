<script setup lang="ts">
/**
 * 联邦只读视图（t3）：待用/已用访问凭证（**不显示 token**）、已知 peer、白名单。
 *
 * 数据源 `federation-status`（mindserver.js / t1 接线）：服务端已做白名单拷贝，
 * `GRANT_PUBLIC_FIELDS` 里**根本没有** token / token_sha256 —— 面板这边再按字段名剥一层。
 */
import { computed, onMounted } from 'vue'
import { store } from '../../stores/agents'
import { federationView, loadFederation, grantState, ensureClock, clock } from '../../stores/world'
import { fmtTime, fmtAgo } from '../../api/time'

onMounted(() => {
  ensureClock()
  void loadFederation()
})

function refresh() { void loadFederation() }

const box = computed(() => {
  if (federationView.phase === 'loading') return { tone: 'dim', text: '读取联邦状态…' }
  if (federationView.phase === 'not-wired') return { tone: 'warn', text: federationView.message }
  if (federationView.phase === 'error') return { tone: 'bad', text: federationView.message }
  return null
})

/** 分组：待用 / 已用（含用尽/过期/作废都由 grantState 判定，这里只按"还能不能用"分两栏）。 */
const usable = computed(() => federationView.grants.filter((g) => grantState(g, clock.now).label === '待用'))
const spent = computed(() => federationView.grants.filter((g) => grantState(g, clock.now).label !== '待用'))

/** visitorWired 三态的**如实**表述（false 不是错误，是现状）。 */
const visitorText = computed(() => {
  if (federationView.visitorWired === true) return '访客判定已接线'
  if (federationView.visitorWired === false) return '访客判定未接线（现在不会有人被判成访客）'
  return '服务端没回 visitorWired（版本较旧，无法判断是否接线）'
})
</script>

<template>
  <div class="wrap scroll">
    <div class="head">
      <h3>联邦</h3>
      <span class="faint small">
        凭证 {{ federationView.grants.length }} 张（待用 {{ usable.length }}）·
        已知对端 {{ federationView.knownPeers.length }} · 白名单 {{ federationView.allowedPeers.length }}
        <template v-if="!store.connected"> · <b class="bad">未连接 mindserver</b></template>
      </span>
      <div class="spacer" />
      <button :disabled="federationView.phase === 'loading' || !store.connected" @click="refresh()">刷新</button>
    </div>

    <div v-if="box" class="msg" :class="box.tone">{{ box.text }}</div>

    <div v-if="federationView.phase === 'ok'" class="msg" :class="federationView.visitorWired === false ? 'warn' : 'dim'">
      {{ visitorText }}<template v-if="federationView.visitorWired === false">
        —— 访问凭证（`visit_grants`）已经能签发/作废/列出，但**核销与"这条连接是谁"的映射还没接**，
        所以真跨机串门仍不可用（federation.md §9）。
      </template>
    </div>

    <template v-if="federationView.phase === 'ok'">
      <!-- ① 凭证（两张表：待用 / 已用） -->
      <div class="panel">
        <div class="panel-title">待用凭证（{{ usable.length }}）· 不含 token</div>
        <div class="table flat">
          <div class="thead">
            <span class="c-id">grantId</span>
            <span class="c-peer">host → guest</span>
            <span class="c-num">用过</span>
            <span class="c-at">签发</span>
            <span class="c-at">到期</span>
            <span class="c-note">备注</span>
          </div>
          <div v-for="g in usable" :key="g.grantId" class="trow">
            <span class="c-id mono" :title="g.grantId">{{ g.grantId }}</span>
            <span class="c-peer mono">{{ g.hostId || '-' }} → {{ g.guestId || '-' }}</span>
            <span class="c-num num">{{ g.usedCount ?? 0 }} / {{ g.maxUses ?? 1 }}</span>
            <span class="c-at faint">{{ fmtTime(g.issuedAt) }}</span>
            <span class="c-at" :title="fmtTime(g.expiresAt)">
              <span class="dim">{{ fmtAgo(g.expiresAt, clock.now) }}</span>
            </span>
            <span class="c-note faint">{{ g.note || '' }}</span>
          </div>
          <div v-if="!usable.length" class="empty faint">
            没有待用凭证（`visit_grants` 里没有还能用的行）—— 这不代表功能坏了，只是还没签过/都用完了。
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">已失效凭证（{{ spent.length }}）· 用尽 / 过期 / 作废</div>
        <div class="table flat">
          <div class="thead">
            <span class="c-id">grantId</span>
            <span class="c-peer">host → guest</span>
            <span class="c-num">用过</span>
            <span class="c-state">状态</span>
            <span class="c-at">失效时间</span>
          </div>
          <div v-for="g in spent" :key="g.grantId" class="trow">
            <span class="c-id mono" :title="g.grantId">{{ g.grantId }}</span>
            <span class="c-peer mono">{{ g.hostId || '-' }} → {{ g.guestId || '-' }}</span>
            <span class="c-num num">{{ g.usedCount ?? 0 }} / {{ g.maxUses ?? 1 }}</span>
            <span class="c-state"><span class="tag" :class="grantState(g, clock.now).tone">{{ grantState(g, clock.now).label }}</span></span>
            <span class="c-at faint">
              {{ g.revokedAt ? '作废 ' + fmtTime(g.revokedAt) : (g.usedAt ? '用掉 ' + fmtTime(g.usedAt) : fmtTime(g.expiresAt)) }}
            </span>
          </div>
          <div v-if="!spent.length" class="empty faint">没有已失效的凭证。</div>
        </div>
      </div>

      <!-- ② 已知对端 -->
      <div class="panel">
        <div class="panel-title">已知对端（{{ federationView.knownPeers.length }}）· 不含公钥</div>
        <div class="table flat">
          <div class="thead">
            <span class="c-id">peerId</span>
            <span class="c-peer">最近地址</span>
            <span class="c-num">名片序号</span>
            <span class="c-at">首次见面</span>
            <span class="c-at">最近见面</span>
          </div>
          <div v-for="p in federationView.knownPeers" :key="p.peerId" class="trow">
            <span class="c-id mono" :title="p.peerId">{{ p.peerId }}</span>
            <span class="c-peer mono faint">{{ p.lastAddr || '-' }}</span>
            <span class="c-num num">{{ p.cardSeq ?? '-' }}</span>
            <span class="c-at faint">{{ fmtTime(p.firstSeen) }}</span>
            <span class="c-at faint">{{ fmtAgo(p.lastSeen, clock.now) }}</span>
          </div>
          <div v-if="!federationView.knownPeers.length" class="empty faint">
            还没有收过任何对端名片（`known_peers` 为空）：没串过门，或对端还没推名片过来。
          </div>
        </div>
      </div>

      <!-- ③ 白名单 -->
      <div class="panel">
        <div class="panel-title">白名单（{{ federationView.allowedPeers.length }}）</div>
        <div class="table flat">
          <div class="thead">
            <span class="c-id">peerId</span>
            <span class="c-at">加入时间</span>
            <span class="c-note">备注</span>
          </div>
          <div v-for="p in federationView.allowedPeers" :key="p.peerId" class="trow">
            <span class="c-id mono">{{ p.peerId }}</span>
            <span class="c-at faint">{{ fmtTime(p.addedAt) }}</span>
            <span class="c-note faint">{{ p.note || '' }}</span>
          </div>
          <div v-if="!federationView.allowedPeers.length" class="empty faint">
            白名单是空的（没有任何对端被允许来访）。
          </div>
        </div>
      </div>
    </template>

    <p class="hint faint">
      只读：本页不签发/不核销/不作废凭证（那些是写操作，只在面板的联邦操作入口里做）。
      **token 永远不会出现在这里**：服务端回执走的是白名单字段（grantId/hostId/guestId/*At/maxUses/usedCount/note），
      库里也只存 `sha256(token)`；签发的那一次回执才带明文 token，且只给发起方看一次。
    </p>
  </div>
</template>

<style scoped>
.wrap { padding: var(--gap); display: flex; flex-direction: column; gap: 8px; height: 100%; overflow: auto; }
.head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.head h3 { font-size: 14px; }
.spacer { flex: 1; }
.small { font-size: 11px; }
.bad { color: var(--bad); }

.msg { font-size: 12px; padding: 7px 10px; border-radius: 6px; line-height: 1.6; }
.msg.dim { color: var(--fg-dim); background: var(--bg-panel); border: 1px solid var(--border-soft); }
.msg.warn { color: var(--warn); background: #26200f; border: 1px solid #4a3f1f; }
.msg.bad { color: var(--bad); background: #261212; border: 1px solid #4a2a2a; }

.table { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.table.flat { border: none; border-radius: 0; }
.thead, .trow { display: flex; align-items: center; gap: 8px; padding: 5px 10px; font-size: 12px; }
.thead { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--fg-faint);
         background: var(--bg); border-bottom: 1px solid var(--border-soft); }
.trow { border-bottom: 1px solid var(--border-soft); }
.trow:last-child { border-bottom: none; }
.empty { padding: 12px; font-size: 12px; }

.c-id { flex: 0 0 168px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.c-peer { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.c-num { flex: 0 0 72px; text-align: right; }
.c-at { flex: 0 0 120px; font-size: 11px; }
.c-state { flex: 0 0 78px; }
.c-note { flex: 0 0 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }

.tag { font-size: 10px; padding: 1px 6px; border-radius: 9px; border: 1px solid var(--border); color: var(--fg-dim); }
.tag.ok { color: var(--ok); border-color: #2a4a2f; background: #12261a; }
.tag.bad { color: var(--bad); border-color: #4a2a2a; background: #261212; }
.tag.plain { color: var(--fg-dim); }
.hint { font-size: 11px; line-height: 1.6; margin: 4px 0 0; }
</style>
