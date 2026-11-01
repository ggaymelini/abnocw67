'use client';

// ============================================================
// Сетевой PvP-бой: клиент.
// Лобби (создание комнаты / вход по коду, спрайт, имя, готовность)
// и бой: снапшоты 20 Гц с авторитетного сервера, интерполяция
// отрисовки, ввод с клавиатуры (стрелки/WASD, J/L — стрела, I — удар).
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { SPRITES, type SpriteId } from '@/lib/sim/settings';
import {
  MP,
  MP_WORLD_H,
  MP_WORLD_W,
  type FloaterEvent,
  type MPRoomState,
  type MPSnapshot,
  type MsgC2S,
  type MsgS2C,
} from '@/lib/mp/protocol';

// ---------------- Утилиты ----------------

const LS_SERVER = 'catwar-mp-server';
const LS_NAME = 'catwar-mp-name';

function normalizeServerUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, '');
  if (!u) return '';
  if (u.startsWith('https://')) u = 'wss://' + u.slice(8);
  else if (u.startsWith('http://')) u = 'ws://' + u.slice(7);
  else if (!u.startsWith('ws://') && !u.startsWith('wss://')) u = 'wss://' + u;
  return u;
}

const ERR_TEXT: Record<string, string> = {
  badname: 'Введите имя (1–16 символов).',
  badsprite: 'Такой кот уже занят — выбрали свободного.',
  badcode: 'Комната не найдена — проверьте код.',
  full: 'В комнате уже максимум игроков (4).',
  roomgone: 'Комната закрылась.',
  notenough: 'Нужно минимум 2 игрока.',
  notready: 'Не все игроки готовы.',
  nothost: 'Начать бой может только хост.',
  server: 'Ошибка сервера, попробуйте ещё раз.',
};

const DIR_BY_CODE: Record<string, number> = {
  ArrowRight: 0,
  KeyD: 0,
  ArrowDown: 90,
  KeyS: 90,
  ArrowLeft: 180,
  KeyA: 180,
  ArrowUp: 270,
  KeyW: 270,
};

/** Направление по набору зажатых клавиш: 1 клавиша — прямое, 2 перпендикулярные — диагональ. */
function dirFromHeld(held: number[]): number | null {
  if (held.length === 0) return null;
  if (held.length === 1) return held[0];
  // Сумма единичных векторов двух последних направлений → ближайшие 45°
  const [a, b] = [held[held.length - 2], held[held.length - 1]];
  const dx = Math.cos((a * Math.PI) / 180) + Math.cos((b * Math.PI) / 180);
  const dy = Math.sin((a * Math.PI) / 180) + Math.sin((b * Math.PI) / 180);
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return b; // противоположные — побеждает последняя
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return ((Math.round(deg / 45) * 45) % 360 + 360) % 360;
}

interface Floater {
  x: number;
  y: number;
  born: number;
  text: string;
  color: string;
}

interface SnapBufItem {
  recvAt: number;
  snap: MPSnapshot;
}

// ============================================================

export default function OnlineClient() {
  const [phase, setPhase] = useState<'setup' | 'lobby' | 'battle'>('setup');
  const [serverUrl, setServerUrl] = useState('');
  const [name, setName] = useState('');
  const [sprite, setSprite] = useState<SpriteId>('blestyashka');
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');
  const [room, setRoom] = useState<MPRoomState | null>(null);
  const [log, setLog] = useState<Array<{ text: string; color: string }>>([]);
  const [ping, setPing] = useState<number | null>(null);
  const [lost, setLost] = useState(false);
  const [copied, setCopied] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const myPidRef = useRef<string>('');
  const roomRef = useRef<MPRoomState | null>(null);
  const phaseRef = useRef(phase);
  const serverUrlRef = useRef(serverUrl);
  const wantCloseRef = useRef(false);
  const snapsRef = useRef<SnapBufItem[]>([]);
  const floatersRef = useRef<Floater[]>([]);
  const heldKeysRef = useRef<number[]>([]);
  const rotRef = useRef<-1 | 0 | 1>(0);
  const sentDirRef = useRef<number | null>(null);
  const sentRotRef = useRef<-1 | 0 | 1>(0);
  const lastStrikeRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const spritesRef = useRef<Partial<Record<SpriteId, HTMLImageElement>>>({});
  const silhouettesRef = useRef<Partial<Record<SpriteId, HTMLCanvasElement>>>({});
  const autoJoinRef = useRef(false);
  const latestKoRef = useRef(false);

  phaseRef.current = phase;
  serverUrlRef.current = serverUrl;

  const me = room?.players.find((p) => p.id === myPidRef.current) ?? null;
  const isHost = !!room && room.hostId === myPidRef.current;
  const connectedPlayers = room?.players.filter((p) => p.connected) ?? [];
  const canStart = isHost && room?.phase === 'lobby' && connectedPlayers.length >= 2 && connectedPlayers.every((p) => p.ready);

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  /** Актуальный спрайт — с сервера (он разрешает конфликты). */
  useEffect(() => {
    if (me && me.sprite !== sprite) setSprite(me.sprite);
  }, [me, sprite]);

  // ---------- Отправка ввода ----------

  const sendInput = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const dir = dirFromHeld(heldKeysRef.current);
    const rot = rotRef.current;
    if (dir !== sentDirRef.current || rot !== sentRotRef.current) {
      sentDirRef.current = dir;
      sentRotRef.current = rot;
      const msg: MsgC2S = { t: 'input', held: dir === null ? [] : [dir], rot };
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const send = useCallback((msg: MsgC2S) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // ---------- Подключение ----------

  const connect = useCallback(
    (opts: { room?: string; rejoin?: string }) => {
      const url = normalizeServerUrl(serverUrlRef.current);
      if (!url) {
        setError('Укажите адрес игрового сервера.');
        return;
      }
      wantCloseRef.current = false;
      setError('');
      setLost(false);
      try {
        wsRef.current?.close();
      } catch {
        /* пусто */
      }
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        setError('Не удалось открыть соединение — проверьте адрес сервера.');
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        const hello: MsgC2S = {
          t: 'hello',
          name: name.trim() || 'Кот',
          sprite,
          room: opts.room,
          rejoin: opts.rejoin,
        };
        ws.send(JSON.stringify(hello));
      };
      ws.onmessage = (ev) => {
        let msg: MsgS2C;
        try {
          msg = JSON.parse(String(ev.data)) as MsgS2C;
        } catch {
          return;
        }
        switch (msg.t) {
          case 'welcome': {
            myPidRef.current = msg.you;
            setLost(false);
            setError('');
            try {
              sessionStorage.setItem('catwar-mp-pid', msg.you);
              sessionStorage.setItem('catwar-mp-code', msg.code);
            } catch {
              /* пусто */
            }
            // сразу готов к бою — хост всё равно ждёт всех
            ws.send(JSON.stringify({ t: 'lobby', ready: true } satisfies MsgC2S));
            break;
          }
          case 'room': {
            setRoom(msg);
            if (msg.phase === 'battle') setPhase('battle');
            else if (phaseRef.current !== 'setup') setPhase('lobby');
            else setPhase('lobby');
            break;
          }
          case 'snap': {
            const buf = snapsRef.current;
            buf.push({ recvAt: performance.now(), snap: msg.snap });
            if (buf.length > 40) buf.splice(0, buf.length - 40);
            for (const e of msg.snap.events) spawnFloater(e);
            const meSnap = msg.snap.players.find((p) => p.id === myPidRef.current);
            latestKoRef.current = !!meSnap?.ko;
            const last = msg.snap.log[msg.snap.log.length - 1];
            setLog((prev) => {
              const prevLast = prev[prev.length - 1];
              if (prevLast && last && prevLast.text === last.text && prev.length === msg.snap.log.length) return prev;
              return msg.snap.log;
            });
            break;
          }
          case 'err': {
            if (msg.code === 'badsprite') {
              // спрайт занят — сервер уже подобрал свободного, просто подсказка
              setError('Этот кот уже занят — выбран свободный спрайт.');
            } else {
              setError(ERR_TEXT[msg.code] ?? 'Ошибка соединения.');
            }
            break;
          }
          case 'bye': {
            setError('Сервер перезапускается — переподключение…');
            setLost(true);
            break;
          }
          default:
            break;
        }
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (wantCloseRef.current) return;
        // авто-реконнект, если мы в комнате
        if (phaseRef.current !== 'setup') {
          setLost(true);
          setTimeout(() => {
            if (wantCloseRef.current || phaseRef.current === 'setup') return;
            const code =
              roomRef.current?.code ||
              (() => {
                try {
                  return sessionStorage.getItem('catwar-mp-code') ?? '';
                } catch {
                  return '';
                }
              })();
            const rejoin = (() => {
              try {
                return sessionStorage.getItem('catwar-mp-pid') ?? undefined;
              } catch {
                return undefined;
              }
            })();
            connect({ room: code || undefined, rejoin: rejoin || undefined });
          }, 1500);
        }
      };
    },
    [name, sprite, sendInput],
  );

  const spawnFloater = useCallback((e: FloaterEvent) => {
    const cx = e.col * MP.FIELD.cellW + MP.FIELD.cellW / 2;
    const cy = e.row * MP.FIELD.cellH + MP.FIELD.cellH * 0.18;
    if (e.kind === 'damage') {
      floatersRef.current.push({ x: cx, y: cy, born: performance.now(), text: e.text, color: e.color });
    } else if (e.kind === 'miss') {
      floatersRef.current.push({ x: cx, y: cy, born: performance.now(), text: 'мимо', color: '#ff453a' });
    } else if (e.kind === 'ko') {
      floatersRef.current.push({ x: cx, y: cy, born: performance.now(), text: e.text, color: '#ff453a' });
    } else if (e.kind === 'respawn') {
      floatersRef.current.push({ x: cx, y: cy, born: performance.now(), text: 'в бой!', color: '#4cd964' });
    }
    if (floatersRef.current.length > 30) floatersRef.current.splice(0, floatersRef.current.length - 30);
  }, []);

  // ---------- Стартовые параметры: localStorage + ?room=&srv= ----------

  useEffect(() => {
    try {
      const savedServer = localStorage.getItem(LS_SERVER) ?? '';
      const savedName = localStorage.getItem(LS_NAME) ?? '';
      setName(savedName);
      const params = new URLSearchParams(window.location.search);
      const urlSrv = params.get('srv');
      const urlRoom = params.get('room');
      const srv = urlSrv ? decodeURIComponent(urlSrv) : savedServer;
      setServerUrl(srv || process.env.NEXT_PUBLIC_GAME_SERVER_URL || '');
      if (urlRoom) {
        setJoinCode(urlRoom.toUpperCase());
        if (srv) {
          // автоприсоединение по ссылке-инвайту
          autoJoinRef.current = true;
        }
      }
    } catch {
      /* пусто */
    }
    // Предзагрузка спрайтов
    for (const s of SPRITES) {
      const img = new Image();
      img.src = s.src;
      img.onload = () => {
        spritesRef.current[s.id] = img;
        // белый силуэт для подсветки активного кота
        const sil = document.createElement('canvas');
        sil.width = img.width;
        sil.height = img.height;
        const sctx = sil.getContext('2d');
        if (sctx) {
          sctx.drawImage(img, 0, 0);
          sctx.globalCompositeOperation = 'source-in';
          sctx.fillStyle = '#ffffff';
          sctx.fillRect(0, 0, sil.width, sil.height);
        }
        silhouettesRef.current[s.id] = sil;
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Автоприсоединение после первого рендера (StrictMode-защита через ref)
  useEffect(() => {
    if (!autoJoinRef.current) return;
    if (!serverUrl || !joinCode || !name) return;
    autoJoinRef.current = false;
    connect({ room: joinCode });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl, joinCode, name]);

  // ---------- Пинг ----------

  useEffect(() => {
    if (phase === 'setup') return;
    const iv = setInterval(() => {
      send({ t: 'ping', ts: Date.now() });
    }, 2000);
    return () => clearInterval(iv);
  }, [phase, send]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    const handler = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data)) as MsgS2C;
        if (msg.t === 'pong') setPing(Date.now() - msg.ts);
      } catch {
        /* пусто */
      }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [phase]);

  // ---------- Клавиатура (в бою) ----------

  useEffect(() => {
    if (phase !== 'battle') return;
    const onKeyDown = (e: KeyboardEvent) => {
      const dir = DIR_BY_CODE[e.code];
      if (dir !== undefined) {
        e.preventDefault();
        if (!heldKeysRef.current.includes(dir)) heldKeysRef.current.push(dir);
        sendInput();
        return;
      }
      if (e.code === 'KeyJ') {
        rotRef.current = -1;
        sendInput();
        return;
      }
      if (e.code === 'KeyL') {
        rotRef.current = 1;
        sendInput();
        return;
      }
      if (e.code === 'KeyI' || e.code === 'Space') {
        e.preventDefault();
        const now = performance.now();
        if (now - lastStrikeRef.current > 120) {
          lastStrikeRef.current = now;
          send({ t: 'strike' });
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const dir = DIR_BY_CODE[e.code];
      if (dir !== undefined) {
        heldKeysRef.current = heldKeysRef.current.filter((d) => d !== dir);
        sendInput();
        return;
      }
      if (e.code === 'KeyJ' && rotRef.current === -1) {
        rotRef.current = 0;
        sendInput();
      }
      if (e.code === 'KeyL' && rotRef.current === 1) {
        rotRef.current = 0;
        sendInput();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      heldKeysRef.current = [];
      rotRef.current = 0;
      sendInput();
    };
  }, [phase, sendInput, send]);

  // ---------- Отрисовка боя ----------

  useEffect(() => {
    if (phase !== 'battle') return;
    let raf = 0;
    const cellW = MP.FIELD.cellW;
    const cellH = MP.FIELD.cellH;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      const now = performance.now();

      ctx.fillStyle = '#2f343a';
      ctx.fillRect(0, 0, MP_WORLD_W, MP_WORLD_H);
      ctx.strokeStyle = '#454c53';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 1; c < MP.FIELD.cols; c++) {
        ctx.moveTo(c * cellW + 0.5, 0);
        ctx.lineTo(c * cellW + 0.5, MP_WORLD_H);
      }
      for (let r = 1; r < MP.FIELD.rows; r++) {
        ctx.moveTo(0, r * cellH + 0.5);
        ctx.lineTo(MP_WORLD_W, r * cellH + 0.5);
      }
      ctx.stroke();

      // Интерполяция между двумя последними снапшотами
      const buf = snapsRef.current;
      if (buf.length === 0) return;
      const target = now - MP.INTERP_MS;
      let s0 = buf[0];
      let s1 = buf[buf.length - 1];
      for (let i = buf.length - 1; i > 0; i--) {
        if (buf[i - 1].recvAt <= target) {
          s0 = buf[i - 1];
          s1 = buf[i];
          break;
        }
      }
      const span = Math.max(1, s1.recvAt - s0.recvAt);
      const k = Math.max(0, Math.min(1, (target - s0.recvAt) / span));
      const lerp = (a: number, b: number) => a + (b - a) * k;
      const lerpAngle = (a: number, b: number) => {
        let d = ((b - a) % 360 + 540) % 360 - 180;
        return a + d * k;
      };

      for (const p1 of s1.snap.players) {
        const p0 = s0.snap.players.find((q) => q.id === p1.id) ?? p1;
        const isSelf = p1.id === myPidRef.current;
        const col = lerp(p0.col, p1.col);
        const row = lerp(p0.row, p1.row);
        const angle = p1.ko ? p0.angle : lerpAngle(p0.angle, p1.angle);
        const energy = lerp(p0.energy, p1.energy);

        const h = (cellH - 10) * 1;
        const w = h * MP.SPRITE_ASPECT;
        const x = col * cellW;
        const y = row * cellH;
        const img = spritesRef.current[p1.sprite];

        // подсветка своего кота (белая растушёвка)
        if (isSelf && !p1.ko) {
          const sil = silhouettesRef.current[p1.sprite];
          if (sil) {
            ctx.save();
            ctx.shadowColor = 'rgba(255,255,255,0.9)';
            ctx.shadowBlur = 12;
            ctx.globalAlpha = 0.85;
            ctx.drawImage(sil, x, y, w, h);
            ctx.drawImage(sil, x, y, w, h);
            ctx.restore();
          }
        }

        ctx.save();
        if (p1.ko) ctx.globalAlpha = 0.35;
        if (img) ctx.drawImage(img, x, y, w, h);
        else {
          ctx.fillStyle = '#8e8e93';
          ctx.fillRect(x, y, w, h);
        }
        ctx.restore();

        // стрела
        if (!p1.ko) {
          const ax = x + w * MP.ARROW_ANCHOR_F;
          const ay = y + h * MP.ARROW_ANCHOR_F + MP.ARROW_OFFSET_Y;
          const rad = (angle * Math.PI) / 180;
          const ex = ax + Math.cos(rad) * MP.ARROW.length;
          const ey = ay + Math.sin(rad) * MP.ARROW.length;
          ctx.strokeStyle = MP.ARROW.color;
          ctx.lineWidth = MP.ARROW.width;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(ex, ey);
          ctx.stroke();
          // наконечник
          const tip = MP.ARROW.tipSize;
          ctx.fillStyle = MP.ARROW.color;
          ctx.beginPath();
          ctx.moveTo(ex + Math.cos(rad) * tip, ey + Math.sin(rad) * tip);
          ctx.lineTo(ex + Math.cos(rad + Math.PI / 2) * tip * 0.55, ey + Math.sin(rad + Math.PI / 2) * tip * 0.55);
          ctx.lineTo(ex + Math.cos(rad - Math.PI / 2) * tip * 0.55, ey + Math.sin(rad - Math.PI / 2) * tip * 0.55);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = MP.ARROW.color;
          ctx.beginPath();
          ctx.arc(ax, ay, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }

        // имя + полоса энергии
        const nameY = y - 14;
        ctx.font = 'bold 13px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = isSelf ? '#ffffff' : '#d4d4d8';
        ctx.fillText(p1.name, x + w / 2, nameY);
        const barW = Math.max(46, w * 0.7);
        const barX = x + w / 2 - barW / 2;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(barX, nameY + 4, barW, 6);
        const pct = Math.max(0, Math.min(100, energy)) / 100;
        ctx.fillStyle = pct > 0.5 ? '#4cd964' : pct > 0.25 ? '#ffd60a' : '#ff453a';
        ctx.fillRect(barX, nameY + 4, barW * pct, 6);

        if (p1.ko) {
          ctx.font = 'bold 16px system-ui, sans-serif';
          ctx.fillStyle = '#ff453a';
          ctx.fillText(`нокаут · ${p1.koRemainS} с`, x + w / 2, y + h / 2);
        }
      }

      // всплывающие события
      const fl = floatersRef.current;
      for (let i = fl.length - 1; i >= 0; i--) {
        const f = fl[i];
        const age = now - f.born;
        if (age > 1200) {
          fl.splice(i, 1);
          continue;
        }
        const a = 1 - age / 1200;
        ctx.save();
        ctx.globalAlpha = a;
        ctx.font = 'bold 20px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        const fy = f.y - (age / 1000) * 34;
        ctx.strokeText(f.text, f.x, fy);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, fy);
        ctx.restore();
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  // ---------- Действия интерфейса ----------

  const persistAndConnect = (opts: { room?: string }) => {
    try {
      localStorage.setItem(LS_SERVER, serverUrl);
      localStorage.setItem(LS_NAME, name.trim() || 'Кот');
    } catch {
      /* пусто */
    }
    connect(opts);
  };

  const createRoom = () => {
    setPhase('lobby');
    persistAndConnect({});
  };

  const joinRoom = () => {
    if (!/^[A-Z2-9]{4}$/.test(joinCode.trim().toUpperCase())) {
      setError('Код комнаты — 4 символа.');
      return;
    }
    setPhase('lobby');
    persistAndConnect({ room: joinCode.trim().toUpperCase() });
  };

  const leave = () => {
    wantCloseRef.current = true;
    send({ t: 'leave' });
    setTimeout(() => {
      try {
        wsRef.current?.close();
      } catch {
        /* пусто */
      }
      wsRef.current = null;
      snapsRef.current = [];
      floatersRef.current = [];
      setRoom(null);
      setLog([]);
      setPhase('setup');
      setLost(false);
      setError('');
    }, 80);
  };

  const copyInvite = async () => {
    if (!room) return;
    const url = `${window.location.origin}/online?room=${room.code}&srv=${encodeURIComponent(normalizeServerUrl(serverUrl))}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Не удалось скопировать — выделите ссылку вручную: ' + url);
    }
  };

  // ================== РЕНДЕР ==================

  const inputCls =
    'w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-400';
  const btnCls =
    'rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <main className="min-h-screen bg-[#1b1e23] text-zinc-100">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <div className="mb-5 flex items-center justify-between">
          <h1 className="text-xl font-bold">🌐 Сетевой бой</h1>
          <Link
            href="/"
            className="rounded-lg border border-zinc-600 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            ← Одиночный симулятор
          </Link>
        </div>

        {/* ---------- Подключение ---------- */}
        {phase === 'setup' && (
          <div className="mx-auto max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
            <label className="mb-1 block text-xs text-zinc-400">Игровое имя</label>
            <input
              className={inputCls + ' mb-3'}
              value={name}
              maxLength={16}
              placeholder="Ваше имя"
              onChange={(e) => setName(e.target.value)}
            />

            <label className="mb-1 block text-xs text-zinc-400">Кот</label>
            <div className="mb-3 grid grid-cols-6 gap-2">
              {SPRITES.map((s) => (
                <button
                  key={s.id}
                  title={s.name}
                  onClick={() => setSprite(s.id)}
                  className={`rounded-lg border-2 p-1 transition-colors ${
                    sprite === s.id ? 'border-emerald-400 bg-emerald-400/10' : 'border-zinc-700 hover:border-zinc-500'
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.src} alt={s.name} className="w-full" />
                </button>
              ))}
            </div>

            <label className="mb-1 block text-xs text-zinc-400">Адрес игрового сервера</label>
            <input
              className={inputCls + ' mb-3'}
              value={serverUrl}
              placeholder="wss://…up.railway.app"
              onChange={(e) => setServerUrl(e.target.value)}
            />

            <div className="mb-3 grid grid-cols-2 gap-2">
              <button onClick={createRoom} className={btnCls + ' bg-emerald-600 hover:bg-emerald-500'}>
                Создать бой
              </button>
              <button onClick={joinRoom} className={btnCls + ' bg-zinc-700 hover:bg-zinc-600'}>
                Войти по коду
              </button>
            </div>
            <input
              className={inputCls + ' mb-1 uppercase tracking-widest'}
              value={joinCode}
              maxLength={4}
              placeholder="КОД (напр. K7X2)"
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && joinRoom()}
            />
            {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
          </div>
        )}

        {/* ---------- Лобби ---------- */}
        {phase === 'lobby' && room && (
          <div className="mx-auto max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
            <div className="mb-4 text-center">
              <div className="text-xs text-zinc-400">Код комнаты</div>
              <div className="text-4xl font-black tracking-[0.3em] text-emerald-400">{room.code}</div>
              <button
                onClick={copyInvite}
                className="mt-2 rounded-lg bg-zinc-700 px-3 py-1.5 text-xs font-semibold hover:bg-zinc-600"
              >
                {copied ? '✓ Ссылка скопирована' : 'Скопировать ссылку-инвайт'}
              </button>
            </div>

            <div className="mb-4 space-y-2">
              {room.players.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/sprites/${p.sprite}.png`} alt={p.name} className="h-10 w-7 object-contain" />
                  <div className="flex-1">
                    <span className="text-sm font-semibold">{p.name}</span>
                    {p.id === myPidRef.current && <span className="ml-1 text-xs text-zinc-400">(вы)</span>}
                    {p.id === room.hostId && <span className="ml-2 text-xs text-amber-400">хост</span>}
                    {!p.connected && <span className="ml-2 text-xs text-red-400">связь потеряна…</span>}
                  </div>
                  <span className={`text-xs ${p.ready ? 'text-emerald-400' : 'text-zinc-500'}`}>
                    {p.ready ? '✓ готов' : '…'}
                  </span>
                </div>
              ))}
            </div>

            <div className="mb-3 grid grid-cols-6 gap-2">
              {SPRITES.map((s) => (
                <button
                  key={s.id}
                  title={s.name}
                  onClick={() => send({ t: 'lobby', sprite: s.id })}
                  className={`rounded-lg border-2 p-1 transition-colors ${
                    me?.sprite === s.id ? 'border-emerald-400 bg-emerald-400/10' : 'border-zinc-700 hover:border-zinc-500'
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.src} alt={s.name} className="w-full" />
                </button>
              ))}
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => send({ t: 'lobby', ready: !me?.ready })}
                className={btnCls + ' flex-1 ' + (me?.ready ? 'bg-emerald-700 hover:bg-emerald-600' : 'bg-zinc-700 hover:bg-zinc-600')}
              >
                {me?.ready ? '✓ Готов' : 'Я готов'}
              </button>
              {isHost && (
                <button
                  onClick={() => send({ t: 'start' })}
                  disabled={!canStart}
                  className={btnCls + ' flex-1 bg-amber-500 text-zinc-900 hover:bg-amber-400'}
                >
                  Начать бой
                </button>
              )}
              <button onClick={leave} className={btnCls + ' bg-zinc-800 hover:bg-zinc-700'}>
                Выйти
              </button>
            </div>
            {isHost && !canStart && (
              <p className="mt-2 text-center text-xs text-zinc-500">
                Нужно ≥2 игроков и готовность каждого.
              </p>
            )}
            {error && <p className="mt-2 text-center text-sm text-red-400">{error}</p>}
          </div>
        )}

        {/* ---------- Бой ---------- */}
        {phase === 'battle' && (
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-md bg-zinc-800 px-2 py-1 font-mono tracking-widest">{room?.code}</span>
              <span
                className={`rounded-md px-2 py-1 ${
                  ping === null
                    ? 'bg-zinc-800 text-zinc-400'
                    : ping < 80
                      ? 'bg-emerald-900 text-emerald-300'
                      : ping < 200
                        ? 'bg-amber-900 text-amber-300'
                        : 'bg-red-900 text-red-300'
                }`}
              >
                {ping === null ? '…' : `${ping} мс`}
              </span>
              <span className="rounded-md bg-zinc-800 px-2 py-1 text-zinc-400">
                Стрелки/WASD — движение · J/L — стрела · I — удар
              </span>
              <button onClick={leave} className="ml-auto rounded-md bg-zinc-800 px-2 py-1 hover:bg-zinc-700">
                Выйти
              </button>
            </div>

            <div className="relative">
              <canvas
                ref={canvasRef}
                width={MP_WORLD_W}
                height={MP_WORLD_H}
                className="block w-full rounded-xl border border-zinc-700"
              />
              {latestKoRef.current && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="rounded-xl bg-red-950/80 px-6 py-3 text-2xl font-black text-red-300">
                    НОКАУТ
                  </div>
                </div>
              )}
              {lost && (
                <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/70">
                  <div className="animate-pulse text-lg font-semibold text-zinc-200">
                    Связь потеряна — переподключение…
                  </div>
                </div>
              )}
            </div>

            {log.length > 0 && (
              <div className="mt-3 rounded-xl border border-zinc-700 bg-zinc-900 p-3">
                <div className="mb-1 text-xs font-semibold text-zinc-400">Боевой лог</div>
                <div className="space-y-0.5 font-mono text-xs">
                  {log.slice().reverse().map((e, i) => (
                    <div key={i} style={{ color: e.color }}>
                      {e.text}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
          </div>
        )}
      </div>
    </main>
  );
}
