// ============================================================
// Сетевой PvP-бой: общий протокол клиента и сервера.
// Этот модуль импортируют и браузер (страница /online), и игровой
// сервер (game-server/) — единый источник форматов сообщений,
// констант боя и геометрии поля.
// ============================================================

import type { SpriteId } from '../sim/settings';

/** Константы сетевого боя (v1 — значения по умолчанию одиночного симулятора). */
export const MP = {
  /** Поле: клетки и их размер в px. */
  FIELD: { cols: 14, rows: 6, cellW: 100, cellH: 150 },
  /** Базовая длительность шага, мс (кулдаун прыжка в клетку). */
  STEP_MS: 120,
  /** Период полного оборота стрелы, с (75°/с). */
  ARROW_PERIOD_SEC: 4.8,
  /** Энергия = здоровье: старт, цена удара, отклик удара, регенерация. */
  ENERGY_START: 100,
  STRIKE_COST: 2,
  STRIKE_RESPONSE_MS: 170,
  REGEN_AMOUNT: 20,
  REGEN_INTERVAL_MS: 5000,
  /** Нокаут: сколько мс кот лежит до авто-возврата в бой. */
  RESPAWN_MS: 5000,
  /** Максимум игроков в комнате. */
  MAX_PLAYERS: 4,
  /** Шаг авторитетной симуляции и частота снапшотов (20 Гц). */
  TICK_MS: 50,
  /** На сколько мс отрисовка клиента отстаёт от свежайшего снапшота (интерполяция). */
  INTERP_MS: 110,
  /** Клетки появления игроков (по порядку подключения). */
  SPAWNS: [
    { col: 1, row: 1 },
    { col: 12, row: 1 },
    { col: 1, row: 4 },
    { col: 12, row: 4 },
  ],
  /** Все спрайты 100×150 — доля ширины/высоты модельки. */
  SPRITE_ASPECT: 2 / 3,
  /** Точка закрепления стрелы: доля ширины/высоты модельки и сдвиг по Y (px). */
  ARROW_ANCHOR_F: 0.5699,
  ARROW_OFFSET_Y: -1,
  /** Отрисовка стрелы. */
  ARROW: { length: 60, width: 6, tipSize: 12, color: '#73a13a' },
} as const;

/** Мир в px (для canvas). */
export const MP_WORLD_W = MP.FIELD.cols * MP.FIELD.cellW; // 1400
export const MP_WORLD_H = MP.FIELD.rows * MP.FIELD.cellH; // 900

// ---------------- Сообщения клиент → сервер ----------------

export type MsgC2S =
  | { t: 'hello'; name: string; sprite: SpriteId; room?: string; rejoin?: string }
  | { t: 'lobby'; name?: string; sprite?: SpriteId; ready?: boolean }
  | { t: 'start' }
  | { t: 'input'; held: number[]; rot: -1 | 0 | 1 }
  | { t: 'strike' }
  | { t: 'ping'; ts: number }
  | { t: 'leave' };

// ---------------- Сообщения сервер → клиент ----------------

/** Коды ошибок подключения/действий (показываются клиентом по-русски). */
export type MPErrorCode =
  | 'badname'
  | 'badsprite'
  | 'badcode'
  | 'full'
  | 'roomgone'
  | 'notenough'
  | 'notready'
  | 'nothost'
  | 'server';

export interface MPError {
  t: 'err';
  code: MPErrorCode;
  msg?: string;
}

export interface MPWelcome {
  t: 'welcome';
  /** Личный стабильный id (для реконнекта). */
  you: string;
  code: string;
  host: boolean;
}

export interface MPRoomPlayer {
  id: string;
  name: string;
  sprite: SpriteId;
  ready: boolean;
  connected: boolean;
}

export interface MPRoomState {
  t: 'room';
  code: string;
  hostId: string;
  phase: 'lobby' | 'battle';
  players: MPRoomPlayer[];
}

/** Всплывающее событие на поле (урон, промах, нокаут, возврат). */
export type FloaterEvent =
  | { kind: 'damage'; col: number; row: number; text: string; color: string }
  | { kind: 'miss'; col: number; row: number }
  | { kind: 'ko'; col: number; row: number; text: string }
  | { kind: 'respawn'; col: number; row: number };

export interface MPLogEntry {
  text: string;
  color: string;
}

export interface MPPlayerSnap {
  id: string;
  name: string;
  sprite: SpriteId;
  col: number;
  row: number;
  angle: number;
  energy: number;
  ko: boolean;
  /** Секунд до возврата в бой (только для нокаутнутых). */
  koRemainS: number;
}

export interface MPSnapshot {
  /** Серверное время, мс (Date.now() сервера). */
  t: number;
  players: MPPlayerSnap[];
  /** События, произошедшие с прошлого снапшота. */
  events: FloaterEvent[];
  /** Последние записи боевого лога. */
  log: MPLogEntry[];
}

export type MsgS2C =
  | MPWelcome
  | MPRoomState
  | { t: 'snap'; snap: MPSnapshot }
  | { t: 'pong'; ts: number }
  | MPError
  | { t: 'bye' };
