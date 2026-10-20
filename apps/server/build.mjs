import { build } from 'esbuild';

await build({
  entryPoints: { index: 'src/index.ts', solverWorker: 'src/solverWorker.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
