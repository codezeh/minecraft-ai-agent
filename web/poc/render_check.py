"""离线复刻 preview-template.html 的投影数学，渲一张 PNG 验证渲染逻辑是否成立。
只用于验证（PPT 参数与前端一致）：yaw=-0.7 pitch=0.9 dist=420 fov=900
"""
import math
import os
import shutil
import sqlite3
import sys
import tempfile

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.abspath(os.path.join(HERE, "..", "..", "mindcraft", "bots", "deepseek", "map", "terrain3d.db"))
OUT = os.path.join(HERE, "render-check.png")

tmp = os.path.join(tempfile.gettempdir(), "terrain3d_render.db")
shutil.copyfile(DB, tmp)
con = sqlite3.connect(tmp)
rows = con.execute("SELECT x, z, y, t FROM surf").fetchall()
bbox = con.execute("SELECT min(x),max(x),min(z),max(z),min(y),max(y) FROM surf").fetchone()
con.close()
os.remove(tmp)

W, H = 1200, 800
yaw, pitch, dist, fov = -0.7, 0.9, 420.0, 900.0
cx = (bbox[0] + bbox[1]) / 2
cz = (bbox[2] + bbox[3]) / 2
cy = (bbox[4] + bbox[5]) / 2

TCOL = {0: (92, 138, 74), 1: (47, 109, 208), 2: (224, 72, 58), 3: (201, 139, 62),
        4: (63, 163, 77), 5: (216, 178, 60), 6: (42, 143, 143)}

cy_, sy_ = math.cos(yaw), math.sin(yaw)
cp, sp = math.cos(pitch), math.sin(pitch)

vis = []
for x, z, y, t in rows:
    X, Y, Z = x - cx, y - cy, z - cz
    x1 = X * cy_ - Z * sy_
    z1 = X * sy_ + Z * cy_
    y1 = Y * cp - z1 * sp
    z2 = Y * sp + z1 * cp
    d = z2 + dist
    if d < 8:
        continue
    s = fov / d
    vis.append((d, W / 2 + x1 * s, H / 2 - y1 * s, y, t))

vis.sort(key=lambda v: -v[0])          # 远 → 近

img = Image.new("RGB", (W, H), (13, 17, 23))
dr = ImageDraw.Draw(img)
base = max(1.2, fov / dist * 1.15)
span = max(1, bbox[5] - bbox[4])
for d, sx, sy, y, t in vis:
    shade = 0.55 + 0.45 * ((y - bbox[4]) / span)
    col = TCOL[t]
    col = tuple(min(255, int(c * shade + 30)) for c in col)
    s = base * (dist / d)
    dr.rectangle([sx - s / 2, sy - s / 2, sx + s / 2, sy + s / 2], fill=col)

# 画面对角线基准框，便于判断构图是否居中
dr.rectangle([W / 2 - 2, H / 2 - 2, W / 2 + 2, H / 2 + 2], fill=(255, 255, 255))
img.save(OUT)
print("wrote", OUT, os.path.getsize(OUT), "bytes; points:", len(vis))
xs = [v[1] for v in vis]
ys = [v[2] for v in vis]
print("screen bbox x[%.0f..%.0f] y[%.0f..%.0f]  (canvas %dx%d)" % (min(xs), max(xs), min(ys), max(ys), W, H))
