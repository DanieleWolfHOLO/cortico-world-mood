/**
 * 把 src/webui/client.ts 打成 dist/webui.js（面板界面）。
 *
 * entry 是 `.ts` 而不是 `.tsx`：面板只用 DOM，不带框架。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [join(ROOT, 'src', 'webui', 'client.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: join(ROOT, 'dist', 'webui.js'),
  charset: 'utf8',
  logLevel: 'error',
});

console.log('dist/webui.js 已生成');
