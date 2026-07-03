// 构建后修复：tsc（moduleResolution:Bundler）输出的相对 import 无扩展名，Node 原生 ESM 会崩。
// 给 dist 里每个相对 import/export-from 补正确后缀：<p>.js 存在→.js；否则 <p>/index.js→/index.js。
// 不动源码（tsx/vitest 本就能解析无扩展名），只让「别人 npm install 后 import」真能用。
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const DIST = 'dist';
const RELATIVE_FROM = /(\bfrom\s+|\bimport\s+)(['"])(\.\.?\/[^'"]*)\2/g;

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function resolveSpecifier(fileDir, spec) {
  if (/\.(js|json|mjs|cjs)$/.test(spec)) return spec; // 已有扩展名，不动
  const abs = resolve(fileDir, spec);
  if (existsSync(`${abs}.js`)) return `${spec}.js`;
  if (existsSync(abs) && statSync(abs).isDirectory() && existsSync(join(abs, 'index.js'))) {
    return `${spec.replace(/\/$/, '')}/index.js`;
  }
  return spec; // 解析不到就原样（不制造更糟）
}

let changed = 0;
for (const file of walk(DIST)) {
  const src = readFileSync(file, 'utf8');
  const fileDir = dirname(file);
  const next = src.replace(RELATIVE_FROM, (m, kw, q, spec) => {
    const fixed = resolveSpecifier(fileDir, spec);
    return fixed === spec ? m : `${kw}${q}${fixed}${q}`;
  });
  if (next !== src) {
    writeFileSync(file, next);
    changed += 1;
  }
}
console.log(`fix-esm-extensions: 处理 ${changed} 个文件的相对导入`);
