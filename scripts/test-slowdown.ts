// Быстрая проверка математики замедлений
import { DEFAULT_SETTINGS, slowdownFor, stepDuration, inWindow } from '../src/lib/sim/settings';

const s = DEFAULT_SETTINGS;
let fail = 0;
function eq(name: string, got: number, want: number) {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: got ${got}, want ${want}`);
}

// Стрела в 0° (смотрит вправо) — как на схеме из игры
eq('вправо при 0° (окно [315..20])', slowdownFor(0, 0, s), 0);
eq('вправо при 350° (в окне)', slowdownFor(0, 350, s), 0);
eq('вправо при 315° (край окна)', slowdownFor(0, 315, s), 0);
eq('вправо при 20° (край окна)', slowdownFor(0, 20, s), 0);
eq('вправо при 21° (вне окна, Δ=21≤45)', slowdownFor(0, 21, s), 40);
eq('вправо при 30° (вне окна)', slowdownFor(0, 30, s), 40);
eq('вправо-вниз при 0° (Δ=45)', slowdownFor(45, 0, s), 40);
eq('вниз при 0° (Δ=90)', slowdownFor(90, 0, s), 70);
eq('влево-вниз при 0° (Δ=135)', slowdownFor(135, 0, s), 90);
eq('влево при 0° (Δ=180)', slowdownFor(180, 0, s), 90);

// Лево: окно [140..220]
eq('влево при 140° (край)', slowdownFor(180, 140, s), 0);
eq('влево при 220° (край)', slowdownFor(180, 220, s), 0);
eq('влево при 139° (вне окна, Δ=41 ≤45)', slowdownFor(180, 139, s), 40);
eq('влево при 221° (вне окна, Δ=41 ≤45)', slowdownFor(180, 221, s), 40);

// Мирный режим
eq('мирный режим', slowdownFor(180, 0, { ...s, arrow: { ...s.arrow, battleMode: false } }), 0);

// Окно через 0°
eq('inWindow через ноль', inWindow(359, { start: 315, end: 20 }) ? 1 : 0, 1);
eq('inWindow обычное', inWindow(180, { start: 140, end: 220 }) ? 1 : 0, 1);
eq('inWindow вне', inWindow(130, { start: 140, end: 220 }) ? 1 : 0, 0);

// Время шага: 40% замедления → 700мс / 0.6 ≈ 1166.67
eq('шаг при 40%', Math.round(stepDuration(700, 40)), Math.round(700 / 0.6));
eq('шаг при 90%', Math.round(stepDuration(700, 90)), Math.round(700 / 0.1));
eq('шаг без замедления', stepDuration(700, 0), 700);

console.log(fail === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛЕНО: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
