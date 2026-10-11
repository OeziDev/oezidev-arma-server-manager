// Ana süreç ve preload'u tek dosyaya paketler (node_modules gerekmez).
// electron-updater da pakete gömülür (saf JS; yerel modül yok). Dışarıda kalanlar: electron ve
// ssh2'nin isteğe bağlı yerel hızlandırıcıları (*.node, cpu-features; yoksa ssh2 JS'e düşer).
import { build, context } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const watch = process.argv.includes('--watch');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['electron', '*.node', 'cpu-features'],
  alias: { '@oezi/arma-core': path.join(root, '../core/src/index.ts') },
  logLevel: 'info',
  legalComments: 'none',
};
const configs = [
  { ...common, entryPoints: [path.join(root, 'src/main/main.ts')], outfile: path.join(root, 'dist/main/main.cjs') },
  { ...common, entryPoints: [path.join(root, 'src/preload/preload.ts')], outfile: path.join(root, 'dist/preload/preload.cjs') },
];
if (watch) {
  for (const c of configs) (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
