"""从 terrain3d.db 导出一份内联数据的单文件 HTML（原型用，只读，不改动原库）。

用法:  python export_preview.py
输出:  terrain3d-preview.html（双击即可打开，无需服务器）
"""
import sqlite3
import shutil
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.abspath(os.path.join(HERE, "..", "..", "mindcraft", "bots", "deepseek", "map", "terrain3d.db"))
TEMPLATE = os.path.join(HERE, "preview-template.html")
OUT = os.path.join(HERE, "terrain3d-preview.html")

if not os.path.exists(DB):
    sys.exit("找不到数据库: " + DB)

# 复制到临时区再读：既不锁住正在写库的 bot 进程，也规避只读打开的权限问题
tmp = os.path.join(tempfile.gettempdir(), "terrain3d_export.db")
shutil.copyfile(DB, tmp)

con = sqlite3.connect(tmp)
rows = con.execute("SELECT x, z, y, t FROM surf ORDER BY z, x, y").fetchall()
bbox = con.execute("SELECT min(x),max(x),min(z),max(z),min(y),max(y) FROM surf").fetchone()
multi = con.execute(
    "SELECT count(*) FROM (SELECT 1 FROM surf GROUP BY x,z HAVING count(*) > 1)"
).fetchone()[0]
con.close()
os.remove(tmp)

if not rows:
    sys.exit("surf 表为空")

xs = ",".join(str(r[0]) for r in rows)
zs = ",".join(str(r[1]) for r in rows)
ys = ",".join(str(r[2]) for r in rows)
ts = ",".join(str(r[3]) for r in rows)

data = (
    "{bbox:[%d,%d,%d,%d,%d,%d],multiColumns:%d,"
    "xs:[%s],zs:[%s],ys:[%s],ts:[%s]}"
    % (bbox[0], bbox[1], bbox[2], bbox[3], bbox[4], bbox[5], multi, xs, zs, ys, ts)
)

with open(TEMPLATE, encoding="utf-8") as f:
    html = f.read()

if "/*__DATA__*/" not in html:
    sys.exit("模板里找不到 /*__DATA__*/ 占位符")

html = html.replace("/*__DATA__*/", data)

# 模板里同一个占位符只应在脚本里出现一次；确认没有残留
if "/*__DATA__*/" in html:
    sys.exit("占位符替换不完整")

with open(OUT, "w", encoding="utf-8") as f:
    f.write(html)

size_mb = os.path.getsize(OUT) / 1024 / 1024
print("已写出: %s (%.2f MB)" % (OUT, size_mb))
print("可站立面: %d   列: %d   多层列: %d (%d%%)"
      % (len(rows), multi and len(rows), multi, round(100 * multi / max(1, len(rows)))))
print("bbox: x[%d..%d] z[%d..%d] y[%d..%d]" % (bbox[0], bbox[1], bbox[2], bbox[3], bbox[4], bbox[5]))
