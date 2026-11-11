import hashlib, os, sys
root = sys.argv[1]
def walk(p):
    out = {}
    for dp, _, fns in os.walk(p):
        for fn in fns:
            f = os.path.join(dp, fn)
            out[os.path.relpath(f, p).replace('\\', '/')] = hashlib.sha256(open(f, 'rb').read()).hexdigest()
    return out
a, b = walk(os.path.join(root, 'web/dist')), walk(os.path.join(root, 'mindcraft/web-dist'))
a.pop('MANIFEST.json', None)
print('web/dist 文件数     :', len(a))
print('mindcraft/web-dist 文件数:', len([k for k in b if k not in ('MANIFEST.json', 'README.md')]))
print('仅 web/dist 有（漏同步）:', sorted(set(a) - set(b)) or '无')
print('仅 web-dist 有（多余产物）:', sorted(k for k in set(b) - set(a) if k not in ('MANIFEST.json', 'README.md')) or '无')
diff = sorted(k for k in set(a) & set(b) if a[k] != b[k])
print('内容不一致（构建不可复现）:', diff or '无')
print('\n判定：' + ('PASS 重新构建的产物与入库产物逐字节一致（可复现）' if not diff and set(a) <= set(b) else 'FAIL'))
