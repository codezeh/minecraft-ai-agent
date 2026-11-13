#!/usr/bin/env node
/**
 * P1-3 发布门禁：docker-compose.yml 能被严格解析，且预期的环境变量都在。
 *
 * 为什么不用 `docker compose config`：本机 docker compose 插件不可用，门禁不能依赖 docker CLI。
 * 为什么不引 yaml 包：mindcraft/node_modules 里的 yaml/js-yaml 都是**传递**依赖（本仓没声明），
 *   重装依赖树就可能消失；这里只用 node 内置模块，实现 compose 需要的 YAML 子集 + 重复键检测。
 *
 * 用法：node scripts/compose-gate.mjs [compose 文件路径]
 * 退出码：0 通过；1 失败（重复键 / 解析不了 / 预期变量缺失）。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const file = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'mindcraft', 'docker-compose.yml')

const errors = []
const bad = (msg) => errors.push(msg)

// ── YAML 子集解析（只做 compose 用得到的构造；遇到不认识的构造宁可报错，不猜）──
const stripInlineComment = (s) => {
  let q = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) { if (c === q) q = null; continue }
    if (c === '"' || c === "'") { q = c; continue }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd()
  }
  return s.trimEnd()
}

const scan = (src) => {
  const out = []
  src.split(/\r?\n/).forEach((raw, i) => {
    const no = i + 1
    if (/^\s*$/.test(raw)) return
    const lead = raw.match(/^[ \t]*/)[0]
    if (lead.includes('\t')) { bad(`第 ${no} 行用 Tab 缩进（YAML 只允许空格）`); return }
    const text = stripInlineComment(raw.slice(lead.length))
    if (!text) return
    out.push({ no, indent: lead.length, text })
  })
  return out
}

// 键值切分：只认「冒号后跟空白或行尾」的映射写法（`a:b` 在 block 上下文里是普通标量）
const splitKey = (text) => {
  let q = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === q) q = null; continue }
    if (c === '"' || c === "'") { q = c; continue }
    if (c === ':' && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      return {
        key: text.slice(0, i).trim().replace(/^["']|["']$/g, ''),
        rest: text.slice(i + 1).trim(),
      }
    }
  }
  return null
}

const isBlockScalar = (rest) => /^[|>][+-]?\d*$/.test(rest)

const parseScalar = (rest) => {
  if (rest === '') return ''
  if (rest.length >= 2 && rest[0] === '"' && rest[rest.length - 1] === '"') return rest.slice(1, -1)
  if (rest.length >= 2 && rest[0] === "'" && rest[rest.length - 1] === "'") return rest.slice(1, -1).replace(/''/g, "'")
  return rest
}

const parseNode = (lines, i, indent) => {
  const first = lines[i]
  if (first.text.startsWith('- ')) return parseSeq(lines, i, indent)
  return parseMap(lines, i, indent)
}

const parseSeq = (lines, i, indent) => {
  const items = []
  while (i < lines.length) {
    const ln = lines[i]
    if (ln.indent < indent) break
    if (ln.indent > indent) { bad(`第 ${ln.no} 行缩进异常（序列项应为 ${indent} 个空格）`); break }
    if (!ln.text.startsWith('- ')) break
    items.push(parseScalar(ln.text.slice(2).trim()))
    i++
  }
  return { value: items, next: i }
}

const parseMap = (lines, i, indent) => {
  const map = new Map()
  const seen = new Map()
  while (i < lines.length) {
    const ln = lines[i]
    if (ln.indent < indent) break
    if (ln.indent > indent) { bad(`第 ${ln.no} 行缩进异常（同级键应为 ${indent} 个空格）`); break }
    if (ln.text.startsWith('- ')) break

    const kv = splitKey(ln.text)
    if (!kv) { bad(`第 ${ln.no} 行不是合法的「键: 值」：${ln.text.slice(0, 60)}`); i++; continue }
    if (seen.has(kv.key)) bad(`重复键：${kv.key}（第 ${seen.get(kv.key)} 行与第 ${ln.no} 行同级重复）`)
    else seen.set(kv.key, ln.no)

    if (kv.rest === '') {
      const nx = lines[i + 1]
      if (nx && nx.indent > indent) {
        const r = parseNode(lines, i + 1, nx.indent)
        map.set(kv.key, r.value)
        i = r.next
      } else if (nx && nx.indent === indent && nx.text.startsWith('- ')) {
        const r = parseSeq(lines, i + 1, indent)
        map.set(kv.key, r.value)
        i = r.next
      } else {
        map.set(kv.key, null)
        i++
      }
      continue
    }

    if (isBlockScalar(kv.rest)) {
      const body = []
      let j = i + 1
      while (j < lines.length && lines[j].indent > indent) { body.push(lines[j].text); j++ }
      map.set(kv.key, body.join('\n'))
      i = j
      continue
    }

    map.set(kv.key, parseScalar(kv.rest))
    i++
  }
  return { value: map, next: i }
}

// ── 门禁断言 ────────────────────────────────────────────────────────
const REQUIRED_ENV = {
  SETTINGS_JSON: { why: '容器内的 settings.js 覆盖项', ok: (v) => typeof v === 'string' && v.trim().length > 0 },
  MIND_SERVER_HOST: { why: '控制台监听地址（丢了容器就只绑回环，发布后连不到）', ok: (v) => v === '0.0.0.0' },
  MINDSERVER_TOKEN: { why: '控制台握手令牌（丢了宿主拿不到 token）', ok: (v) => /\$\{MINDSERVER_TOKEN:\?/.test(String(v)) },
  MC_WORLD_DIR: { why: '存档目录（丢了每次重建容器换 world_id，面板看起来被清空）', ok: (v) => v === '/app/world' },
}

let doc = null
let src = ''
try {
  src = fs.readFileSync(file, 'utf8')
  doc = parseNode(scan(src), 0, 0).value
} catch (e) {
  bad(`读取/解析失败：${e.message}`)
}

if (doc instanceof Map) {
  const services = doc.get('services')
  const svc = services instanceof Map ? services.get('mindcraft') : null
  if (!(svc instanceof Map)) {
    bad('services.mindcraft 不存在（compose 结构已变？）')
  } else {
    const env = svc.get('environment')
    if (!(env instanceof Map)) {
      bad('services.mindcraft.environment 不是映射（应为 `environment:` + 缩进的键值对）')
    } else {
      for (const [key, rule] of Object.entries(REQUIRED_ENV)) {
        if (!env.has(key)) bad(`environment 缺变量 ${key}（${rule.why}）`)
        else if (!rule.ok(env.get(key))) bad(`environment.${key} 的值不对：${JSON.stringify(env.get(key))}（${rule.why}）`)
      }
      const extra = [...env.keys()].filter((k) => !(k in REQUIRED_ENV))
      if (extra.length) console.log(`NOTE   environment 另有变量（不影响门禁）：${extra.join(', ')}`)
    }
  }
  // 同一 service 下 environment 只许出现一次（重复键本身已在上面判死，这里是可读的第二道）
  const envLines = src.split(/\r?\n/).filter((l) => /^\s{4}environment:\s*$/.test(l)).length
  if (envLines !== 1) bad(`services.mindcraft 的 environment 出现了 ${envLines} 次（必须是 1 次）`)
}

if (errors.length) {
  console.log(`FAIL  compose 门禁：${path.relative(ROOT, file)}`)
  for (const e of errors) console.log(`      · ${e}`)
  process.exit(1)
}
console.log(`PASS  compose 可解析，environment 单一且变量完整（${Object.keys(REQUIRED_ENV).join(', ')}）`)
process.exit(0)
