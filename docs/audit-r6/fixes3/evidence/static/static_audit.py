#!/usr/bin/env python3
"""R6 t4 静态审计（只读，不改产品代码）：
   1) 扫 web/src 的 var(--x)，逐个对 styles/tokens.css 验证可解析
   2) router.ts 路由 ↔ views/*.vue ↔ App.vue 导航 三方对应
   3) 文案兜底：label/映射表查找是否有 fallback（不出现 undefined 渲染）
"""
import re, os, glob, collections, sys
ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..', '..')
os.chdir(os.path.join(ROOT, 'web', 'src'))
fail = 0

# ── 1. CSS 变量 ─────────────────────────────────────────────
defined, owner = set(), {}
for p in glob.glob('**/*.css', recursive=True):
    t = open(p, encoding='utf-8').read()
    for m in re.finditer(r'(--[A-Za-z0-9_-]+)\s*:', t):
        defined.add(m.group(1)); owner.setdefault(m.group(1), p)
uses = collections.defaultdict(list)
dynamic = []
for p in glob.glob('**/*', recursive=True):
    if os.path.isfile(p) and p.rsplit('.', 1)[-1] in ('vue', 'css', 'ts'):
        for ln, line in enumerate(open(p, encoding='utf-8').read().splitlines(), 1):
            for m in re.finditer(r'var\(\s*(--[A-Za-z0-9_-]+)', line):
                uses[m.group(1)].append(f'{p}:{ln}')
            if re.search(r'var\(\s*(?!--)', line):
                dynamic.append(f'{p}:{ln}')
missing = {k: v for k, v in uses.items() if k not in defined}
print('== 1. CSS 变量 ==')
print(f'  tokens.css 定义 {len(defined)} 个；web/src 里 var() 引用 {len(uses)} 个不同变量')
print(f'  未定义（幽灵变量）: {len(missing)}')
for k, v in sorted(missing.items()):
    print(f'    FAIL {k} 被引用 {len(v)} 次：{v[:5]}'); fail += 1
ghost = [k for k in ('--text-dim',) if k in uses or k in defined]
print(f'  上轮幽灵变量 --text-dim 出现次数: {len(ghost)}' + ('  ← 复发！' if ghost else '  （未复发）'))
if ghost: fail += 1
print(f'  非字面量 var() 用法（无法静态判解析）: {len(dynamic)}')
for d in dynamic: print('    WARN', d)

# ── 2. 路由 ────────────────────────────────────────────────
print('\n== 2. 路由 ↔ 视图 ==')
router = open('router.ts', encoding='utf-8').read()
routes = []
for blk in re.split(r'\{\s*\n?\s*path:', router)[1:]:
    p = re.match(r"\s*'([^']+)'", blk)
    n = re.search(r"name:\s*'([^']+)'", blk)
    c = re.search(r"component:\s*(?:\(\)\s*=>\s*import\('([^']+)'\)|([A-Za-z]+))", blk)
    is_redirect = 'redirect:' in blk.split('component:')[0]
    if p: routes.append((p.group(1), n.group(1) if n else '?', (c.group(1) or c.group(2)) if c else '?', is_redirect))
views = {os.path.basename(v) for v in glob.glob('views/*.vue')}
print(f'  router.ts 路由 {len(routes)} 条（其中重定向 {sum(1 for r in routes if r[3])} 条）：')
for path, name, comp, is_redirect in routes:
    if is_redirect:
        print(f"    SKIP {path:18s} 重定向路由（无组件，不算死路由）")
        continue
    base = os.path.basename(comp)
    fname = base if base.endswith('.vue') else base + '.vue'
    ok = os.path.exists(os.path.join('views', fname))
    print(f"    {'OK  ' if ok else 'FAIL'} {path:12s} name={name:9s} → views/{fname}")
    if not ok: fail += 1
mapped = {os.path.basename((c if c.endswith('.vue') else c + '.vue')) for _, _, c, rd in routes if not rd}
orphan = sorted(views - mapped)
print(f'  views/*.vue 共 {len(views)} 个；未被任何路由引用（孤儿视图）: {orphan or "无"}')
if orphan: fail += 1
app = open('App.vue', encoding='utf-8').read()
nav = dict(re.findall(r"\{\s*to:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}", app))
labels = {}
for blk in re.split(r'\{\s*\n?\s*path:', router)[1:]:
    p = re.match(r"\s*'([^']+)'", blk); l = re.search(r"meta:\s*\{\s*label:\s*'([^']+)'", blk)
    if p and l: labels[p.group(1)] = l.group(1)
dead = [p for p in nav if p not in labels]
nonav = [p for p in labels if p not in nav]
mismatch = [(p, nav[p], labels[p]) for p in nav if p in labels and nav[p] != labels[p]]
print(f'  App.vue 导航 {len(nav)} 条；死链（指向不存在路由）: {dead or "无"}')
print(f'  路由无导航入口: {nonav or "无"}；label 不一致: {mismatch or "无"}')
if dead or mismatch: fail += 1

# ── 3. 文案兜底 ────────────────────────────────────────────
print('\n== 3. 文案/映射表兜底 ==')
maps = {}
for p in glob.glob('**/*.vue', recursive=True) + glob.glob('**/*.ts', recursive=True):
    t = open(p, encoding='utf-8').read()
    for m in re.finditer(r'const (\w+): Record<[^>]+> = \{([^}]*)\}', t):
        maps[m.group(1)] = p
print(f'  找到 {len(maps)} 个 Record 映射表：{sorted(maps)}')
# 对每个映射表的模板查找，检查是否有 || 兜底
for name, p in sorted(maps.items()):
    for f in glob.glob('**/*.vue', recursive=True):
        t = open(f, encoding='utf-8').read()
        for m in re.finditer(re.escape(name) + r'\[[^\]]+\](\s*\|\|[^"\'}]*)?', t):
            fb = (m.group(1) or '').strip()
            print(f"    {'OK  ' if fb else 'WARN'} {f}: {m.group(0)[:60]}")
print('  说明：Vue 模板里 class 绑定为 undefined 时不渲染该 class（不会出现 "undefined" 文本），'
      '故无 || 兜底属低危；会渲染文本的映射表必须有兜底。')
print(f'\n结果：fail={fail}')
sys.exit(1 if fail else 0)
