#!/usr/bin/env python3
"""Проверка переключателя «Точка закрепления и подсветка наведения»:
- diff между вкл/выкл должен быть маленьким (только точки закрепления + маркер);
- цвет стрелы #73a13a должен остаться на поле в обоих состояниях (стрела видна всегда).
"""
from PIL import Image
import sys

on = Image.open('/tmp/render/ray_on.png').convert('RGB')
off = Image.open('/tmp/render/ray_off.png').convert('RGB')
if on.size != off.size:
    print('SIZES DIFFER', on.size, off.size)
    sys.exit(1)

w, h = on.size
pon, poff = on.load(), off.load()

def close(a, b, tol=6):
    return abs(a[0]-b[0]) <= tol and abs(a[1]-b[1]) <= tol and abs(a[2]-b[2]) <= tol

diff_px = 0
minx, miny, maxx, maxy = w, h, -1, -1
for y in range(h):
    for x in range(w):
        if not close(pon[x, y], poff[x, y]):
            diff_px += 1
            if x < minx: minx = x
            if x > maxx: maxx = x
            if y < miny: miny = y
            if y > maxy: maxy = y

# пиксели цвета стрелы (допуск по компонентам)
ARROW = (0x73, 0xa1, 0x3a)
def arrow_pixels(p):
    n = 0
    for y in range(h):
        for x in range(w):
            c = p[x, y]
            if abs(c[0]-ARROW[0]) <= 14 and abs(c[1]-ARROW[1]) <= 14 and abs(c[2]-ARROW[2]) <= 14:
                n += 1
    return n

n_on, n_off = arrow_pixels(pon), arrow_pixels(poff)
print(f'canvas {w}x{h}')
print(f'diff pixels: {diff_px}  bbox: ({minx},{miny})..({maxx},{maxy})')
print(f'arrow-color pixels: on={n_on} off={n_off}  (off/on = {n_off/max(1,n_on):.3f})')

# приговор: diff маленький относительно числа пикселей стрелы => спрятались только точки
ok_small = diff_px < 0.25 * n_on
ok_arrow = n_off > 0.6 * n_on
print('VERDICT:', 'PASS — спрятались только точки закрепления/подсветка, стрелы на месте'
      if ok_small and ok_arrow else 'FAIL — проверь вручную')
