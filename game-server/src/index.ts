// ============================================================
// Авторитетный игровой сервер сетевого PvP-боя.
// Node.js + WebSocket (ws). Комнаты по короткому коду, лобби
// (имя, спрайт, готовность, старт от хоста), бой на тиках 20 Гц
// с рассылкой снапшотов, реконнект по личному pid, позднее
// подключение в идущий бой.
//
// Деплой (Railway): root directory = game-server,
// build = npm run build, start = npm start, порт из env PORT.
// ============================================================

import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  addLatePlayer,
  applyInput,
  createBattle,
  isSprite,
  removePlayer,
  requestStrike,
  snapshotOf,
  tickBattle,
  type Battle,
} from '../../src/lib/mp/battle';
import { MP } from '../../src/lib/mp/protocol';
import type {
  FloaterEvent,
  MPRoomPlayer,
  MPRoomState,
  MPSnapshot,
  MsgC2S,
  MsgS2C,
} from '../../src/lib/mp/protocol';
import type { SpriteId } from '../../src/lib/sim/settings';

const PORT = Number(process.env.PORT) || 8080;
const RECONNECT_GRACE_MS = 15000;

// ---------------- Утилиты ----------------

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode(): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}
function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

interface RoomPlayer {
  pid: string;
  ws: WebSocket | null;
  name: string;
  sprite: SpriteId;
  ready: boolean;
  disconnectedAt: number | null;
}

interface Room {
  code: string;
  hostPid: string;
  phase: 'lobby' | 'battle';
  players: Map<string, RoomPlayer>;
  battle: Battle | null;
  timer: ReturnType<typeof setInterval> | null;
}

const rooms = new Map<string, Room>();

function send(ws: WebSocket, msg: MsgS2C): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function roomStateMsg(room: Room): MPRoomState {
  const players: MPRoomPlayer[] = [];
  for (const p of room.players.values()) {
    players.push({
      id: p.pid,
      name: p.name,
      sprite: p.sprite,
      ready: p.ready,
      connected: p.ws !== null,
    });
  }
  return { t: 'room', code: room.code, hostId: room.hostPid, phase: room.phase, players };
}

function broadcast(room: Room, msg: MsgS2C): void {
  for (const p of room.players.values()) if (p.ws) send(p.ws, msg);
}

function broadcastRoom(room: Room): void {
  broadcast(room, roomStateMsg(room));
}

function transferHostIfNeeded(room: Room): void {
  const host = room.players.get(room.hostPid);
  if (host && host.ws !== null) return;
  const next = [...room.players.values()].find((p) => p.ws !== null);
  if (next) {
    room.hostPid = next.pid;
    console.log(`[room ${room.code}] хост → ${next.name}`);
  }
}

function destroyRoom(room: Room): void {
  if (room.timer) clearInterval(room.timer);
  room.timer = null;
  rooms.delete(room.code);
  console.log(`[room ${room.code}] закрыта`);
}

function removeAndBroadcast(room: Room, pid: string): void {
  const p = room.players.get(pid);
  if (!p) return;
  room.players.delete(pid);
  if (room.battle && room.phase === 'battle') removePlayer(room.battle, pid);
  console.log(`[room ${room.code}] ${p.name} покинул комнату`);
  if (room.players.size === 0) {
    destroyRoom(room);
    return;
  }
  transferHostIfNeeded(room);
  broadcastRoom(room);
}

/** Игрок потерял связь: держим место 15 с на реконнект. */
function scheduleDropCheck(room: Room, pid: string): void {
  setTimeout(() => {
    const p = room.players.get(pid);
    if (p && p.ws === null) removeAndBroadcast(room, pid);
  }, RECONNECT_GRACE_MS);
}

function startBattle(room: Room): void {
  const entries = [...room.players.values()].map((p) => ({
    id: p.pid,
    name: p.name,
    sprite: p.sprite,
  }));
  room.phase = 'battle';
  room.battle = createBattle(entries, Date.now());
  room.timer = setInterval(() => tickRoom(room), MP.TICK_MS);
  console.log(`[room ${room.code}] бой начался: ${entries.map((e) => e.name).join(', ')}`);
  broadcastRoom(room);
}

function tickRoom(room: Room): void {
  const battle = room.battle;
  if (!battle) return;
  const now = Date.now();
  const events: FloaterEvent[] = [];
  tickBattle(battle, now, MP.TICK_MS, events);
  const { players, log } = snapshotOf(battle, now, events);
  const snap: MPSnapshot = { t: now, players, events, log };
  broadcast(room, { t: 'snap', snap });
}

/** Свободный спрайт: если занят — автоматически берём следующий свободный. */
const ALL_SPRITES: SpriteId[] = [
  'puhlyashik',
  'blestyashka',
  'puzatik',
  'razdora',
  'pohititel',
  'syrstyashka',
];
function pickFreeSprite(room: Room, wanted: SpriteId, exceptPid?: string): SpriteId {
  const taken = new Set<SpriteId>();
  for (const p of room.players.values()) {
    if (p.pid !== exceptPid) taken.add(p.sprite);
  }
  if (!taken.has(wanted)) return wanted;
  for (const s of ALL_SPRITES) if (!taken.has(s)) return s;
  return wanted; // недостижимо при максимуме 4 игроков
}

// ---------------- hello: создать комнату / войти / рекннект ----------------

interface Binding {
  room: Room;
  pid: string;
}

function onHello(ws: WebSocket, msg: Extract<MsgC2S, { t: 'hello' }>): Binding | null {
  const name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 16) : '';
  if (!name) {
    send(ws, { t: 'err', code: 'badname' });
    return null;
  }
  if (!isSprite(msg.sprite)) {
    send(ws, { t: 'err', code: 'badsprite' });
    return null;
  }

  // Реконнект: возвращаемся в свою комнату под своим pid
  if (msg.rejoin && msg.room) {
    const room = rooms.get(msg.room.toUpperCase());
    const p = room?.players.get(msg.rejoin);
    if (!room || !p) {
      send(ws, { t: 'err', code: 'roomgone' });
      return null;
    }
    if (p.ws && p.ws !== ws) p.ws.close();
    p.ws = ws;
    p.disconnectedAt = null;
    p.name = name;
    send(ws, { t: 'welcome', you: p.pid, code: room.code, host: room.hostPid === p.pid });
    broadcastRoom(room);
    console.log(`[room ${room.code}] ${p.name} переподключился`);
    return { room, pid: p.pid };
  }

  // Вход по коду
  if (msg.room) {
    const room = rooms.get(msg.room.toUpperCase());
    if (!room) {
      send(ws, { t: 'err', code: 'badcode' });
      return null;
    }
    if (room.players.size >= MP.MAX_PLAYERS) {
      send(ws, { t: 'err', code: 'full' });
      return null;
    }
    const pid = randomId();
    const sprite = pickFreeSprite(room, msg.sprite);
    room.players.set(pid, { pid, ws, name, sprite, ready: false, disconnectedAt: null });
    send(ws, { t: 'welcome', you: pid, code: room.code, host: false });
    if (room.phase === 'battle' && room.battle) {
      addLatePlayer(room.battle, { id: pid, name, sprite }, Date.now());
    }
    broadcastRoom(room);
    console.log(`[room ${room.code}] ${name} вошёл${room.phase === 'battle' ? ' (в бой)' : ''}`);
    return { room, pid };
  }

  // Новая комната
  let code = randomCode();
  while (rooms.has(code)) code = randomCode();
  const room: Room = { code, hostPid: '', phase: 'lobby', players: new Map(), battle: null, timer: null };
  rooms.set(code, room);
  const pid = randomId();
  room.players.set(pid, { pid, ws, name, sprite: msg.sprite, ready: false, disconnectedAt: null });
  room.hostPid = pid;
  send(ws, { t: 'welcome', you: pid, code: room.code, host: true });
  broadcastRoom(room);
  console.log(`[room ${code}] создана, хост: ${name}`);
  return { room, pid };
}

// ---------------- Остальные сообщения ----------------

function onMessage(room: Room, pid: string, ws: WebSocket, msg: MsgC2S): void {
  const player = room.players.get(pid);
  if (!player) return;

  switch (msg.t) {
    case 'hello':
      // повторный hello по живому соединению — игнор
      break;
    case 'lobby': {
      if (room.phase !== 'lobby') break;
      if (typeof msg.name === 'string') {
        const n = msg.name.trim().slice(0, 16);
        if (n) player.name = n;
      }
      if (isSprite(msg.sprite)) {
        player.sprite = pickFreeSprite(room, msg.sprite, pid);
      }
      if (typeof msg.ready === 'boolean') player.ready = msg.ready;
      broadcastRoom(room);
      break;
    }
    case 'start': {
      if (room.hostPid !== pid) {
        send(ws, { t: 'err', code: 'nothost' });
        break;
      }
      if (room.phase !== 'lobby') break;
      const connected = [...room.players.values()].filter((p) => p.ws !== null);
      if (connected.length < 2) {
        send(ws, { t: 'err', code: 'notenough' });
        break;
      }
      if (!connected.every((p) => p.ready)) {
        send(ws, { t: 'err', code: 'notready' });
        break;
      }
      startBattle(room);
      break;
    }
    case 'input': {
      if (room.phase !== 'battle' || !room.battle) break;
      const held = Array.isArray(msg.held) ? msg.held.map(Number).slice(0, 8) : [];
      const rot = msg.rot === -1 ? -1 : msg.rot === 1 ? 1 : 0;
      applyInput(room.battle, pid, held, rot, Date.now());
      break;
    }
    case 'strike': {
      if (room.phase !== 'battle' || !room.battle) break;
      requestStrike(room.battle, pid, Date.now());
      break;
    }
    case 'leave': {
      ws.close();
      removeAndBroadcast(room, pid);
      break;
    }
    default:
      break;
  }
}

// ---------------- HTTP + WebSocket ----------------

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('catwar game server');
});

const wss = new WebSocketServer({ server: httpServer, path: '/' });

// Лимит сообщений: не больше 60 в секунду на соединение
const msgTimes = new WeakMap<WebSocket, number[]>();
function rateLimit(ws: WebSocket): boolean {
  const now = Date.now();
  const arr = (msgTimes.get(ws) ?? []).filter((t) => now - t < 1000);
  if (arr.length >= 60) return false;
  arr.push(now);
  msgTimes.set(ws, arr);
  return true;
}

wss.on('connection', (ws: WebSocket) => {
  const alive = ws as WebSocket & { isAlive?: boolean };
  alive.isAlive = true;
  ws.on('pong', () => {
    alive.isAlive = true;
  });

  let binding: Binding | null = null;

  ws.on('message', (data: unknown) => {
    if (!rateLimit(ws)) return;
    let msg: MsgC2S;
    try {
      msg = JSON.parse(String(data)) as MsgC2S;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

    if (msg.t === 'hello') {
      if (binding) return; // уже привязан
      binding = onHello(ws, msg);
      return;
    }
    if (msg.t === 'ping') {
      send(ws, { t: 'pong', ts: Number((msg as { ts?: number }).ts) || 0 });
      return;
    }
    if (!binding) return;
    onMessage(binding.room, binding.pid, ws, msg);
  });

  ws.on('close', () => {
    if (!binding) return;
    const { room, pid } = binding;
    const p = room.players.get(pid);
    if (!p) return;
    p.ws = null;
    p.disconnectedAt = Date.now();
    console.log(`[room ${room.code}] ${p.name} потерял связь (${RECONNECT_GRACE_MS / 1000} с на реконнект)`);
    scheduleDropCheck(room, pid);
    transferHostIfNeeded(room);
    broadcastRoom(room);
  });

  ws.on('error', () => {
    /* соединение закроется само */
  });
});

// keepalive: рвём мёртвые соединения
setInterval(() => {
  for (const ws of wss.clients) {
    const alive = ws as WebSocket & { isAlive?: boolean };
    if (alive.isAlive === false) {
      ws.terminate();
      continue;
    }
    alive.isAlive = false;
    ws.ping();
  }
}, 30000);

httpServer.listen(PORT, () => {
  console.log(`Игровой сервер запущен на порту ${PORT}`);
});

// Мягкое завершение (Railway присылает SIGTERM при редеплое)
process.on('SIGTERM', () => {
  for (const room of rooms.values()) broadcast(room, { t: 'bye' });
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
