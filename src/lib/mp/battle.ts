// ============================================================
// Сетевой PvP-бой: авторитетный тик-движок.
// Выполняется ТОЛЬКО на игровом сервере. Правила те же, что в
// одиночном симуляторе: стрела вращается вручную (J/L), шаг —
// прыжок в соседнюю клетку с кулдауном stepMs × замедление,
// удар (клавиша I) срабатывает через «отклик удара» по снимку
// стойки: диагональ — зона по стойке + обязательное окно,
// прямая стойка — зона по лучу стрелы (rayBox → resolveZonePixel).
// Энергия = здоровье; промах бесплатен, попадание стоит
// strikeCost атакующему и списывает урон с цели.
// ============================================================

import {
  DEFAULT_SETTINGS,
  SPRITES,
  dirByDeg,
  inWindow,
  rayBox,
  resolveZonePixel,
  slowdownFor,
  stepDuration,
  wrap360,
  wrap180,
  type RayBoxHit,
  type SpriteId,
  type WindowKey,
} from '../sim/settings';
import { MP } from './protocol';
import type { FloaterEvent, MPLogEntry, MPPlayerSnap } from './protocol';

/** Настройки-источник правил (окна замедления, зоны, геометрия поля). */
const RULES = DEFAULT_SETTINGS;
const ZONES = RULES.combat.zones;
const WINDOWS = RULES.slowdown.windows;
const TIERS = RULES.slowdown.tiers;

// slowdownFor читает s.arrow.battleMode / s.slowdown — подсовываем дефолты целиком.

export interface BattlePlayer {
  id: string;
  name: string;
  sprite: SpriteId;
  col: number;
  row: number;
  angle: number;
  energy: number;
  ko: boolean;
  koAt: number;
  /** Зажатые направления (°), последнее — приоритетное (как held в одиночном симе). */
  held: number[];
  /** Ручное вращение стрелы: -1 против часовой, +1 по часовой. */
  rot: -1 | 0 | 1;
  /** Активный шаг (кулдаун): старт и длительность. */
  step: { start: number; dur: number } | null;
  lastRegen: number;
}

interface PendingStrike {
  id: string;
  resolveAt: number;
  col: number;
  row: number;
  angle: number;
}

export interface Battle {
  players: Map<string, BattlePlayer>;
  pending: PendingStrike[];
  log: MPLogEntry[];
}

export interface BattleEntry {
  id: string;
  name: string;
  sprite: SpriteId;
}

/** Свободная клетка появления: максимально удалённая от живых противников. */
export function freeSpawnCell(battle: Battle | null, taken: Array<{ col: number; row: number }>): { col: number; row: number } {
  const occupied = new Set<string>();
  if (battle) for (const p of battle.players.values()) occupied.add(`${p.col}:${p.row}`);
  for (const t of taken) occupied.add(`${t.col}:${t.row}`);
  let best: { col: number; row: number } = MP.SPAWNS[0];
  let bestScore = -1;
  for (const s of MP.SPAWNS) {
    if (occupied.has(`${s.col}:${s.row}`)) continue;
    let minDist = Infinity;
    for (const key of occupied) {
      const [c, r] = key.split(':').map(Number);
      minDist = Math.min(minDist, Math.abs(c - s.col) + Math.abs(r - s.row));
    }
    const score = occupied.size === 0 ? 1 : minDist;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return { col: best.col, row: best.row };
}

/** Создание боя: игроки расставляются по клеткам появления. */
export function createBattle(entries: BattleEntry[], now: number): Battle {
  const players = new Map<string, BattlePlayer>();
  entries.forEach((e, i) => {
    const spawn = MP.SPAWNS[i % MP.SPAWNS.length];
    players.set(e.id, {
      id: e.id,
      name: e.name,
      sprite: e.sprite,
      col: spawn.col,
      row: spawn.row,
      angle: 0,
      energy: MP.ENERGY_START,
      ko: false,
      koAt: 0,
      held: [],
      rot: 0,
      step: null,
      lastRegen: now,
    });
  });
  return { players, pending: [], log: [] };
}

/** Ввод игрока: зажатые направления и вращение стрелы. */
export function applyInput(battle: Battle, id: string, held: number[], rot: -1 | 0 | 1, now: number): void {
  const p = battle.players.get(id);
  if (!p || p.ko) return;
  const dirs: number[] = [];
  for (const d of held) {
    const n = Number(d);
    if ([0, 45, 90, 135, 180, 225, 270, 315].includes(n)) dirs.push(n);
    if (dirs.length >= 8) break;
  }
  p.held = dirs;
  p.rot = rot === -1 || rot === 1 ? rot : 0;
  // смена ввода не отменяет текущий кулдаун шага — как в одиночном симе
  void now;
}

/** Запрос удара: резолвится через STRIKE_RESPONSE_MS по снимку стойки. */
export function requestStrike(battle: Battle, id: string, now: number): boolean {
  const p = battle.players.get(id);
  if (!p || p.ko) return false;
  // один удар «в полёте» на игрока — спам не копит очередь
  if (battle.pending.some((s) => s.id === id)) return false;
  battle.pending.push({ id, resolveAt: now + MP.STRIKE_RESPONSE_MS, col: p.col, row: p.row, angle: p.angle });
  return true;
}

function logPush(battle: Battle, text: string, color: string): void {
  battle.log.push({ text, color });
  if (battle.log.length > 30) battle.log.splice(0, battle.log.length - 30);
}

/** Кого заденет удар: живой сосед, точнее всех наведённый стрелой. */
function pickStrikeTarget(battle: Battle, atk: BattlePlayer, snap: PendingStrike): BattlePlayer | null {
  let best: BattlePlayer | null = null;
  let bestDiff = Infinity;
  for (const t of battle.players.values()) {
    if (t.id === atk.id || t.ko) continue;
    const dx = t.col - snap.col;
    const dy = t.row - snap.row;
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1) continue;
    const phi = wrap360((Math.atan2(dy, dx) * 180) / Math.PI);
    const diff = Math.abs(wrap180(phi - wrap360(snap.angle)));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = t;
    }
  }
  return best;
}

/** Геометрия как в одиночном симе: моделька привязана к левому верхнему углу клетки. */
function spriteBox(col: number, row: number) {
  const h = (MP.FIELD.cellH - 10) * 1; // scale 100%
  const w = h * MP.SPRITE_ASPECT;
  return { x: col * MP.FIELD.cellW, y: row * MP.FIELD.cellH, w, h };
}

function anchorOf(col: number, row: number) {
  const b = spriteBox(col, row);
  return {
    ax: b.x + b.w * MP.ARROW_ANCHOR_F,
    ay: b.y + b.h * MP.ARROW_ANCHOR_F + MP.ARROW_OFFSET_Y,
  };
}

/** Какая половина тела поражена при входе луча через данный край. */
function entrySide(hit: Pick<RayBoxHit, 'edge' | 'nx'>): 'left' | 'right' {
  if (hit.edge === 'left') return 'left';
  if (hit.edge === 'right') return 'right';
  return hit.nx < 50 ? 'left' : 'right';
}

/** Разрешение одного отложенного удара. Возвращает события. */
function resolveStrike(battle: Battle, snap: PendingStrike, now: number, events: FloaterEvent[]): void {
  const atk = battle.players.get(snap.id);
  if (!atk || atk.ko) return;
  const t = pickStrikeTarget(battle, atk, snap);
  if (!t) return; // рядом никого — тихий промах (как «удар в пустоту»)

  const dx = t.col - snap.col;
  const dy = t.row - snap.row;
  const diagonal = Math.abs(dx) === 1 && Math.abs(dy) === 1;
  let zone: (typeof ZONES)[number] | null = null;

  if (diagonal) {
    // Удар с диагонали: зона по стойке, стрела обязана стоять в окне направления.
    const phi = wrap360((Math.atan2(dy, dx) * 180) / Math.PI);
    const forcedId = phi === 45 || phi === 135 ? 'muzzle' : phi === 225 ? 'tail' : 'paws';
    const win = WINDOWS[String(phi) as WindowKey];
    const z = win && inWindow(snap.angle, win) ? ZONES.find((zz) => zz.id === forcedId) : undefined;
    zone = z ?? null;
  } else {
    // Прямая стойка: зона — полоса тела, в которую входит луч стрелы.
    const a = anchorOf(snap.col, snap.row);
    const box = spriteBox(t.col, t.row);
    const rad = (snap.angle * Math.PI) / 180;
    const hit = rayBox(a.ax, a.ay, Math.cos(rad), Math.sin(rad), box.x, box.y, box.w, box.h);
    zone = hit.hit ? resolveZonePixel(hit.ny, entrySide(hit), ZONES) : null;
  }

  if (!zone) {
    events.push({ kind: 'miss', col: snap.col, row: snap.row });
    return;
  }

  atk.energy = Math.max(0, atk.energy - MP.STRIKE_COST);
  t.energy = Math.max(0, t.energy - zone.damage);
  events.push({
    kind: 'damage',
    col: t.col,
    row: t.row,
    text: `${zone.name} -${zone.damage}%`,
    color: zone.color,
  });
  logPush(battle, `${atk.name} → ${t.name}: ${zone.name} −${zone.damage}%`, zone.color);

  if (t.energy <= 0) {
    t.ko = true;
    t.koAt = now;
    t.held = [];
    t.rot = 0;
    t.step = null;
    events.push({ kind: 'ko', col: t.col, row: t.row, text: `${t.name} — нокаут` });
    logPush(battle, `${atk.name} нокаутировал ${t.name}`, '#ff453a');
  }
}

/** Свободная для движения клетка (тела всех игроков — препятствия). */
function cellBlocked(battle: Battle, self: string, col: number, row: number): boolean {
  for (const p of battle.players.values()) {
    if (p.id !== self && p.col === col && p.row === row) return true;
  }
  return false;
}

/** Один тик симуляции: вращение, движение, удары, регенерация, нокауты. */
export function tickBattle(battle: Battle, now: number, dtMs: number, events: FloaterEvent[]): void {
  // 1. Вращение стрелы (вручную, только в бою — в бою всегда «боевой режим»)
  for (const p of battle.players.values()) {
    if (p.ko || p.rot === 0) continue;
    p.angle = wrap360(p.angle + p.rot * (360 / MP.ARROW_PERIOD_SEC) * (dtMs / 1000));
  }

  // 2. Движение: кулдаун шага + автоповтор при удержании
  for (const p of battle.players.values()) {
    if (p.ko) continue;
    if (p.step && now >= p.step.start + p.step.dur) p.step = null;
    if (!p.step && p.held.length > 0) {
      const dir = p.held[p.held.length - 1];
      const d = dirByDeg(dir);
      const tc = p.col + d.dx;
      const tr = p.row + d.dy;
      if (tc < 0 || tc >= MP.FIELD.cols || tr < 0 || tr >= MP.FIELD.rows) continue;
      if (cellBlocked(battle, p.id, tc, tr)) continue;
      const sd = slowdownFor(dir, p.angle, RULES);
      const dur = stepDuration(MP.STEP_MS, sd);
      p.col = tc;
      p.row = tr;
      p.step = { start: now, dur };
    }
  }

  // 3. Удары «в полёте»
  if (battle.pending.length > 0) {
    const due = battle.pending.filter((s) => now >= s.resolveAt);
    if (due.length > 0) {
      battle.pending = battle.pending.filter((s) => now < s.resolveAt);
      for (const s of due) resolveStrike(battle, s, now, events);
    }
  }

  // 4. Регенерация энергии
  for (const p of battle.players.values()) {
    if (now - p.lastRegen < MP.REGEN_INTERVAL_MS) continue;
    p.lastRegen += MP.REGEN_INTERVAL_MS;
    if (now - p.lastRegen > MP.REGEN_INTERVAL_MS * 3) p.lastRegen = now; // после лагов не копим долги
    if (!p.ko) p.energy = Math.min(MP.ENERGY_START, p.energy + MP.REGEN_AMOUNT);
  }

  // 5. Возврат из нокаута
  for (const p of battle.players.values()) {
    if (!p.ko || now - p.koAt < MP.RESPAWN_MS) continue;
    const cell = freeSpawnCell(battle, []);
    p.ko = false;
    p.energy = MP.ENERGY_START;
    p.col = cell.col;
    p.row = cell.row;
    p.angle = 0;
    p.step = null;
    events.push({ kind: 'respawn', col: p.col, row: p.row });
    logPush(battle, `${p.name} вернулся в бой`, '#4cd964');
  }
}

/** Снимок состояния для рассылки. */
export function snapshotOf(battle: Battle, now: number, events: FloaterEvent[]): {
  players: MPPlayerSnap[];
  log: MPLogEntry[];
} {
  const players: MPPlayerSnap[] = [];
  for (const p of battle.players.values()) {
    players.push({
      id: p.id,
      name: p.name,
      sprite: p.sprite,
      col: p.col,
      row: p.row,
      angle: Math.round(p.angle * 10) / 10,
      energy: Math.round(p.energy),
      ko: p.ko,
      koRemainS: p.ko ? Math.max(0, Math.ceil((p.koAt + MP.RESPAWN_MS - now) / 1000)) : 0,
    });
  }
  return { players, log: battle.log.slice(-10) };
}

/** Добавление игрока в идущий бой (позднее подключение). */
export function addLatePlayer(battle: Battle, entry: BattleEntry, now: number): void {
  const cell = freeSpawnCell(battle, []);
  battle.players.set(entry.id, {
    id: entry.id,
    name: entry.name,
    sprite: entry.sprite,
    col: cell.col,
    row: cell.row,
    angle: 0,
    energy: MP.ENERGY_START,
    ko: false,
    koAt: 0,
    held: [],
    rot: 0,
    step: null,
    lastRegen: now,
  });
  logPush(battle, `${entry.name} присоединился к бою`, '#ffd60a');
}

/** Удаление игрока из боя (ушёл). */
export function removePlayer(battle: Battle, id: string): void {
  const p = battle.players.get(id);
  if (!p) return;
  battle.players.delete(id);
  battle.pending = battle.pending.filter((s) => s.id !== id);
  logPush(battle, `${p.name} покинул бой`, '#8e8e93');
}

/** Валидный спрайт? */
export function isSprite(v: unknown): v is SpriteId {
  return typeof v === 'string' && SPRITES.some((s) => s.id === v);
}
