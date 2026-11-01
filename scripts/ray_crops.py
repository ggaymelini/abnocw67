#!/usr/bin/env python3
"""Кропы вокруг трёх кластеров изменений (вкл слева / выкл справа), x5."""
from PIL import Image

on = Image.open('/tmp/render/ray_on.png').convert('RGB')
off = Image.open('/tmp/render/ray_off.png').convert('RGB')

# центры кластеров в координатах скриншота (BOX offset 25,75 + клетка 25px)
centers = {'a': (25 + 912, 75 + 287), 'b': (25 + 487, 75 + 512), 'c': (25 + 637, 75 + 512)}
R = 40
for name, (cx, cy) in centers.items():
    box = (cx - R, cy - R, cx + R, cy + R)
    con = on.crop(box).resize((R * 8, R * 8), Image.NEAREST)
    coff = off.crop(box).resize((R * 8, R * 8), Image.NEAREST)
    side = Image.new('RGB', (R * 16 + 12, R * 8), (255, 0, 255))
    side.paste(con, (0, 0))
    side.paste(coff, (R * 8 + 12, 0))
    side.save(f'/tmp/render/zone_{name}.png')
    print(name, box)
