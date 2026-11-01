#!/usr/bin/env python3
"""Дифф только области игрового канваса (панель настроек исключена — она скроллится)."""
from PIL import Image

on = Image.open('/tmp/render/ray_on.png').convert('RGB')
off = Image.open('/tmp/render/ray_off.png').convert('RGB')

# область канваса на скриншоте (без панели справа и подписей снизу)
BOX = (25, 75, 1055, 755)
on_c = on.crop(BOX)
off_c = off.crop(BOX)
w, h = on_c.size
pon, poff = on_c.load(), off_c.load()

def close(a, b, tol=6):
    return abs(a[0]-b[0]) <= tol and abs(a[1]-b[1]) <= tol and abs(a[2]-b[2]) <= tol

diff = 0
clusters = []  # соберём bbox зон изменений грубо, по сетке 25px
grid = {}
for y in range(h):
    for x in range(w):
        if not close(pon[x, y], poff[x, y]):
            diff += 1
            key = (x // 25, y // 25)
            grid[key] = grid.get(key, 0) + 1

cells = sorted(grid.items(), key=lambda kv: -kv[1])[:12]
print(f'canvas region {w}x{h}, diff pixels: {diff}')
print('top change clusters (cell_x*25, cell_y*25 -> px):')
for (cx, cy), n in cells:
    print(f'  ({cx*25},{cy*25}) -> {n}')

ARROW = (0x73, 0xa1, 0x3a)
def arrow_pixels(p):
    n = 0
    for y in range(h):
        for x in range(w):
            c = p[x, y]
            if abs(c[0]-ARROW[0]) <= 14 and abs(c[1]-ARROW[1]) <= 14 and abs(c[2]-ARROW[2]) <= 14:
                n += 1
    return n

a_on, a_off = arrow_pixels(pon), arrow_pixels(poff)
print(f'arrow-color px in canvas: on={a_on} off={a_off} (off/on={a_off/max(1,a_on):.2f})')
print('VERDICT:', 'PASS' if (diff < 4000 and a_off > 0.75 * a_on) else 'CHECK MANUALLY')

# приближённые кропы оснований стрел: игрок (8,2), Пухляшик (4,4), Пузатик (6,4)
# канвас на странице: клетка 100x150, начало ~ (25,75); скриншот как есть
for name, (cx, cy) in {'player': (8, 2), 'target1': (4, 4), 'target2': (6, 4)}.items():
    x0 = 25 + cx * 100 + 55
    y0 = 75 + cy * 150 + 70
    crop_on = on.crop((x0 - 25, y0 - 25, x0 + 45, y0 + 25)).resize((280, 200), Image.NEAREST)
    crop_off = off.crop((x0 - 25, y0 - 25, x0 + 45, y0 + 25)).resize((280, 200), Image.NEAREST)
    side = Image.new('RGB', (570, 200), (20, 20, 20))
    side.paste(crop_on, (0, 0))
    side.paste(crop_off, (290, 0))
    side.save(f'/tmp/render/anchor_{name}.png')
print('crops saved')
