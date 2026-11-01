#!/usr/bin/env python3
"""Обработка спрайта персонажа: удаление чёрного фона + обрезка."""
from PIL import Image
from collections import deque

SRC = "/home/z/my-project/upload/a4e8a4ca2795eae8.png"
DST = "/home/z/my-project/public/character.png"

img = Image.open(SRC).convert("RGBA")
w, h = img.size
print("source size:", w, h)
px = img.load()

# Порог темноты для фона
TH = 28

def is_dark(x, y):
    r, g, b, a = px[x, y]
    return a == 0 or (r < TH and g < TH and b < TH)

# Заливка от краёв: убираем только связанный с краем тёмный фон
visited = [[False] * w for _ in range(h)]
q = deque()
for x in range(w):
    for y in (0, h - 1):
        if is_dark(x, y) and not visited[y][x]:
            visited[y][x] = True
            q.append((x, y))
for y in range(h):
    for x in (0, w - 1):
        if is_dark(x, y) and not visited[y][x]:
            visited[y][x] = True
            q.append((x, y))

while q:
    x, y = q.popleft()
    px[x, y] = (0, 0, 0, 0)
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nx, ny = x + dx, y + dy
        if 0 <= nx < w and 0 <= ny < h and not visited[ny][nx] and is_dark(nx, ny):
            visited[ny][nx] = True
            q.append((nx, ny))

# Лёгкое размытие альфы по краю, чтобы сгладить ореол
from PIL import ImageFilter
alpha = img.split()[3]
alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.6))
img.putalpha(alpha)

# Обрезка по непрозрачной области
bbox = img.getbbox()
print("bbox:", bbox)
img = img.crop(bbox)
print("result size:", img.size)

img.save(DST)
print("saved:", DST)
