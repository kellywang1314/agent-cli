import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

const outputDirectory = 'dist/web-assets';

/** 打包浏览器脚本和样式，并复制固定 HTML 外壳。 */
async function buildWeb() {
  await mkdir(outputDirectory, { recursive: true });
  await build({
    entryPoints: ['src/web/client.tsx'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['safari16.4', 'chrome110'],
    outfile: `${outputDirectory}/app.js`,
    jsx: 'automatic',
    minify: true,
    sourcemap: true,
    legalComments: 'none',
    loader: { '.css': 'css' },
    assetNames: '[name]',
  });
  await copyFile('src/web/index.html', `${outputDirectory}/index.html`);
}

await buildWeb();
