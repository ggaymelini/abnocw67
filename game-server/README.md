# Игровой сервер сетевого PvP-боя (catwar-battle-sim)

Авторитетный Node.js-сервер: комнаты по коду, лобби, бой на тиках 20 Гц,
снапшоты по WebSocket, реконнект, позднее подключение в идущий бой.

Правила боя (окна замедления, зоны, геометрия) импортируются из
`../src/lib/sim/settings.ts` и `../src/lib/mp/battle.ts` — сервер и сайт
всегда считают бой по одним и тем же правилам.

## Локальный запуск

```bash
cd game-server
npm install        # или bun install
npm run build      # esbuild → dist/index.js
npm start          # порт из env PORT, по умолчанию 8080
```

Проверка: `npm test` (нужен запущенный сервер на том же порту) —
17 дымовых проверок: комнаты, лобби, старт, снапшоты 20 Гц, движение,
вращение стрелы, удары, поздний вход, реконнект.

## Деплой на Railway (бесплатный тариф)

1. Убедитесь, что код Push в GitHub (`ggaymelini/abnocw`).
2. [railway.app](https://railway.app) → войти через GitHub → **New Project → Deploy from GitHub repo** → выбрать `abnocw`.
3. В сервисе: **Settings → Build → Root Directory** = `game-server`
   (Railway сам выполнит `npm install`, `npm run build`, `npm start` из `game-server/package.json`).
4. **Settings → Networking → Generate Domain** — получите публичный адрес вида
   `catwar-game-server-production.up.railway.app`.
5. Этот адрес — адрес игрового сервера. На странице `/online` сайта впишите его
   в поле «Адрес игрового сервера» как `wss://catwar-game-server-production.up.railway.app`
   (или добавьте переменную `NEXT_PUBLIC_GAME_SERVER_URL` при сборке сайта на Vercel).

Порт сервер берёт из `PORT` (Railway задаёт его сам), health-check: `GET /health`.

## Клиент (страница /online)

- Адрес сервера хранится в localStorage браузера.
- Ссылка-инвайт несёт и код комнаты, и адрес сервера:
  `https://ваш-сайт/online?room=K7X2&srv=wss%3A%2F%2F...` — гостю ничего вводить не надо.
- Управление: стрелки/WASD — движение (две перпендикулярные клавиши — диагональ),
  J/L — вращение стрелы против/по часовой, I или Space — удар.
- При обрыве связи клиент сам переподключается в течение 15 секунд и возвращается в бой.
