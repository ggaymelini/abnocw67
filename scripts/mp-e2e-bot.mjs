// E2E-бот: подключается к комнате по коду (argv[2]) и становится готовым.
// Использование: node mp-e2e-bot.mjs КОД [порт]
import { createRequire } from 'module';
const require = createRequire('/home/z/my-project/game-server/index.js');
const WebSocket = require('ws');

const code = process.argv[2];
const port = process.argv[3] || '8080';
const ws = new WebSocket(`ws://localhost:${port}/`);
ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'hello', name: 'БотВторой', sprite: 'puhlyashik', room: code }));
});
ws.on('message', (data) => {
  const m = JSON.parse(String(data));
  if (m.t === 'welcome') {
    ws.send(JSON.stringify({ t: 'lobby', ready: true }));
    console.log('BOT-READY');
  }
  if (m.t === 'room' && m.phase === 'battle') {
    console.log('BOT-IN-BATTLE players=' + m.players.length);
  }
  if (m.t === 'snap') {
    if (!global.counted) global.counted = 0;
    global.counted++;
    if (global.counted === 20) console.log('BOT-SNAPS-OK 20');
  }
});
ws.on('error', (e) => {
  console.error('BOT-ERR', e.message);
  process.exit(1);
});
// живём 30 секунд
setTimeout(() => process.exit(0), 30000);
