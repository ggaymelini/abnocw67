// Сборка игрового сервера: один самодостаточный CJS-файл на Node 18+.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: 'dist/index.js',
  sourcemap: false,
  logLevel: 'info',
});
