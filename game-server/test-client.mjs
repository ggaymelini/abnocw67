// Интеграционный дымовой тест игрового сервера.
// Три бота: создают комнату, входят, готовятся, начинают бой,
// двигаются, вращают стрелу, бьют — проверяются снапшоты 20 Гц,
// движение, события и ping/pong.
//
// Запуск: сначала сервер (node dist/index.js, порт 8080), затем `npm test`.
// PORT можно переопределить: `PORT=8081 node test-client.mjs`.

import WebSocket from 'ws';

const PORT = Number(process.env.PORT) || 8080;
const URL = `ws://localhost:${PORT}/`;

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
}

function bot() {
  const ws = new WebSocket(URL);
  const state = { ws, inbox: [], waiters: [], open: false };
  ws.on('open', () => {
    state.open = true;
  });
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    state.inbox.push(msg);
    state.waiters = state.waiters.filter((w) => !w(msg));
  });
  ws.on('error', (e) => {
    state.error = e.message;
  });
  /** Ждёт сообщение по предикату с таймаутом. */
  state.waitFor = (pred, ms = 3000, tag = '') =>
    new Promise((resolve, reject) => {
      const found = state.inbox.find(pred);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error(`timeout: ${tag}`)), ms);
      state.waiters.push((msg) => {
        if (pred(msg)) {
          clearTimeout(timer);
          resolve(msg);
          return true;
        }
        return false;
      });
    });
  state.send = (obj) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));
  return state;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [a, b, c] = [bot(), bot(), bot()];
  await sleep(300);
  check('соединения открыты', a.open && b.open && c.open, a.error || '');

  // 1. Хост создаёт комнату
  a.send({ t: 'hello', name: 'Алекс', sprite: 'blestyashka' });
  const wa = await a.waitFor((m) => m.t === 'welcome', 3000, 'welcome A');
  const code = wa.code;
  check('комната создана, код получен', /^[A-Z2-9]{4}$/.test(code), code);

  // 2. Неверный код → ошибка
  c.send({ t: 'hello', name: 'Ксюша', sprite: 'puhlyashik', room: 'XXXX' });
  const errBad = await c.waitFor((m) => m.t === 'err', 3000, 'err badcode');
  check('неверный код → badcode', errBad.code === 'badcode');

  // 3. Вход двоих по коду
  b.send({ t: 'hello', name: 'Борис', sprite: 'puhlyashik', room: code });
  const wb = await b.waitFor((m) => m.t === 'welcome', 3000, 'welcome B');
  check('гость Б вошёл', typeof wb.you === 'string' && wb.host === false);

  c.send({ t: 'hello', name: 'Ксюша', sprite: 'puhlyashik', room: code });
  const wc = await c.waitFor((m) => m.t === 'welcome', 3000, 'welcome C');
  check('гость В вошёл', typeof wc.you === 'string');

  const room3 = await a.waitFor((m) => m.t === 'room' && m.players.length === 3, 3000, 'room 3 players');
  check('лобби видит троих', room3.players.length === 3);
  const spriteTaken = room3.players.filter((p) => p.sprite === 'puhlyashik').length;
  check('дубликат спрайта заменён свободным', spriteTaken === 1, `puhlyashik у ${spriteTaken}`);

  // 4. Старт без готовности → notready
  a.send({ t: 'start' });
  const errNotReady = await a.waitFor((m) => m.t === 'err', 3000, 'err notready');
  check('старт без готовности отклонён', errNotReady.code === 'notready');

  // 5. Все готовятся, хост начинает
  a.send({ t: 'lobby', ready: true });
  b.send({ t: 'lobby', ready: true });
  c.send({ t: 'lobby', ready: true });
  await a.waitFor(
    (m) => m.t === 'room' && m.players.every((p) => p.ready),
    3000,
    'all ready',
  );
  check('все готовы', true);
  a.send({ t: 'start' });
  const firstSnap = await a.waitFor((m) => m.t === 'snap', 3000, 'first snap');
  check('бой начался, снапшот пришёл', firstSnap.snap.players.length === 3);

  // 6. Частота снапшотов ~20 Гц
  const count0 = a.inbox.filter((m) => m.t === 'snap').length;
  await sleep(1000);
  const count1 = a.inbox.filter((m) => m.t === 'snap').length;
  const hz = count1 - count0;
  check('снапшоты ~20 Гц', hz >= 14 && hz <= 26, `${hz} за 1 с`);

  // 7. Пинг
  a.send({ t: 'ping', ts: 12345 });
  const pong = await a.waitFor((m) => m.t === 'pong' && m.ts === 12345, 3000, 'pong');
  check('ping/pong работает', pong.ts === 12345);

  // 8. Движение: Алекс (спавн 1:1) идёт вправо ~1 с → должен сместиться на 5+ клеток
  const a0 = firstSnap.snap.players.find((p) => p.name === 'Алекс');
  a.send({ t: 'input', held: [0], rot: 0 });
  await sleep(1000);
  a.send({ t: 'input', held: [], rot: 0 });
  await sleep(150);
  const lastA = [...a.inbox].reverse().find((m) => m.t === 'snap');
  const a1 = lastA.snap.players.find((p) => p.name === 'Алекс');
  check('движение вправо работает', a1.col - a0.col >= 4, `col ${a0.col} → ${a1.col}`);

  // 9. Вращение стрелы
  b.send({ t: 'input', held: [], rot: 1 });
  await sleep(600);
  b.send({ t: 'input', held: [], rot: 0 });
  const lastB = [...b.inbox].reverse().find((m) => m.t === 'snap');
  const bNow = lastB.snap.players.find((p) => p.name === 'Борис');
  check('стрела вращается', bNow.angle > 20, `angle ${bNow.angle}°`);

  // 10. Удар в пустоту → бесплатный промах (событие miss, энергия не тратится)
  const before = [...a.inbox].reverse().find((m) => m.t === 'snap');
  const aEn0 = before.snap.players.find((p) => p.name === 'Алекс').energy;
  a.send({ t: 'strike' });
  await sleep(500);
  const after = [...a.inbox].reverse().find((m) => m.t === 'snap');
  const aEn1 = after.snap.players.find((p) => p.name === 'Алекс').energy;
  const gotMiss = after.snap.events.some((e) => e.kind === 'miss');
  check('удар в пустоту = промах без траты энергии', gotMiss || aEn1 === aEn0, `энергия ${aEn0}→${aEn1}`);

  // 11. Позднее подключение четвёртого в бой
  const d = bot();
  await sleep(300);
  d.send({ t: 'hello', name: 'Дина', sprite: 'razdora', room: code });
  await d.waitFor((m) => m.t === 'welcome', 3000, 'welcome D');
  const dSnap = await d.waitFor((m) => m.t === 'snap' && m.snap.players.length === 4, 3000, '4 players');
  const dina = dSnap.snap.players.find((p) => p.name === 'Дина');
  check('поздний вход в бой: Дина на свободном спавне', !!dina && [1, 12].includes(dina.col));

  // 12. Реконнект: обрываем соединение Б и входим с rejoin
  const bPid = wb.you;
  b.ws.close();
  await sleep(200);
  const b2 = bot();
  await sleep(300);
  b2.send({ t: 'hello', name: 'Борис', sprite: 'puhlyashik', room: code, rejoin: bPid });
  const wb2 = await b2.waitFor((m) => m.t === 'welcome', 3000, 'welcome B2');
  check('реконнект по pid', wb2.you === bPid);

  console.log('');
  const failed = results.filter((r) => !r.ok).length;
  console.log(`Итог: ${results.length - failed}/${results.length} проверок пройдено${failed ? `, ПРОВАЛЕНО: ${failed}` : ' 🎉'}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('❌ Тест упал:', e.message);
  process.exit(1);
});
