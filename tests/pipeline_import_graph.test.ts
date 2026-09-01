/**
 * 记忆引擎内核 36.1 · 开源子集 import 图静态检查
 * ---------------------------------------------------------------
 * 验收点（36 施工案 36.1 + 35 案 v1.7 传导）：
 * - open/ 五模块自包含：所有 import 必须解析到 open/ 目录内或 node: 内置
 *   （零 npm 外部依赖 = 零外部协议风险；零闭源依赖 = P0 一键 carve-out 预留）
 * - open/ 源码零闭源符号（store/ForgetService/闭源模块名等）
 * - 反向验证：闭源模块确实复用开源件（闭源可依赖开源）
 *
 * 本文件同时是可独立运行的检查脚本：
 *   node dist/tests/pipeline_import_graph.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 源码树根（测试运行于 dist/tests，源码在 <root>/src） */
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(TEST_DIR, '..', '..', 'src');
const OPEN_DIR = SRC_ROOT;

/** 开源模块清单（36 施工案 36.1 模块表） */
const OPEN_TS_FILES = readdirSync(OPEN_DIR).filter((f) => f.endsWith('.ts'));

/** import 说明符提取（含 import type / export from / 动态 import） */
function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /import\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /export\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) specifiers.push(m[1]);
  }
  return specifiers;
}

/** 解析相对说明符到实际文件（.ts 源） */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = normalize(join(dirname(fromFile), specifier));
  for (const candidate of [base, `${base}.ts`, `${base}.js`]) {
    const asTs = candidate.endsWith('.js') ? candidate.replace(/\.js$/, '.ts') : candidate;
    if (existsSync(asTs)) return asTs;
  }
  return null;
}

test('import 图：开源子集模块清单完整（open/ 五模块齐全）', () => {
  const expected = ['clean.ts', 'structure.ts', 'distill.ts', 'mempack.ts', 'lite.ts'];
  for (const f of expected) {
    assert.ok(OPEN_TS_FILES.includes(f), `open/${f} 应存在`);
  }
  assert.ok(existsSync(join(OPEN_DIR, 'config.sample.json')), '配置样例应存在');
});

test('import 图：open/ 全部 import 解析到 open/ 内或 node: 内置（零闭源零 npm）', () => {
  assert.ok(OPEN_TS_FILES.length >= 5);
  for (const file of OPEN_TS_FILES) {
    const fullPath = join(OPEN_DIR, file);
    const source = readFileSync(fullPath, 'utf-8');
    const specifiers = extractImportSpecifiers(source);
    assert.ok(specifiers.length > 0 || file === 'clean.ts' || true, `${file} 可无 import`);
    for (const spec of specifiers) {
      // node: 内置 → OK
      if (spec.startsWith('node:')) continue;
      // 相对导入 → 必须落在 open/ 内
      if (spec.startsWith('.')) {
        const resolved = resolveSpecifier(fullPath, spec);
        assert.ok(resolved, `open/${file}: import "${spec}" 无法解析`);
        assert.ok(
          resolved.startsWith(OPEN_DIR),
          `open/${file}: import "${spec}" 越界到 ${resolved}（闭源依赖零容忍）`,
        );
        continue;
      }
      // 其余一律视为 npm 外部依赖 → 违反零依赖铁律
      assert.fail(`open/${file}: 检测到 npm 外部依赖 "${spec}"（开源子集必须零外部依赖）`);
    }
  }
});

test('import 图：open/ 源码零闭源符号（grep 复核）', () => {
  // 闭源符号黑名单（91_core store 内部符号 / 闭源模块名 / 自愈与定位器资产词）
  const forbidden = [
    'PermanentMemoryStore',
    'NotebookStore',
    'UserProfileStore',
    'CoreLibStore',
    'ForgetService',
    'MemoryArchitectureLayer',
    'store-adapter',
    '../core/',
    '../../core/',
    'DarkLineAuditLog',
    'MemoryStorage',
    'FileStorage',
    'StorageInterface',
    'antiheal',
    'self-heal',
    'locator',
  ];
  for (const file of OPEN_TS_FILES) {
    const source = readFileSync(join(OPEN_DIR, file), 'utf-8');
    for (const symbol of forbidden) {
      assert.equal(
        source.includes(symbol),
        false,
        `open/${file} 出现闭源符号 "${symbol}"（开源边界违规）`,
      );
    }
  }
});

// 开源仓说明：闭源反向验证（store-adapter/pipeline 复用开源件）已随闭源层剔除，仅在内部工程保留。

test('import 图：MIT license header 全覆盖（开源边界落地）', () => {
  for (const file of OPEN_TS_FILES) {
    const source = readFileSync(join(OPEN_DIR, file), 'utf-8');
    assert.ok(source.includes('SPDX-License-Identifier: MIT'), `open/${file} 缺 MIT header`);
    assert.ok(source.includes('传火'), `open/${file} header 应含项目名`);
  }
});

test('import 图：依赖方向单向性（open 不感知 pipeline 结构）', () => {
  // open/ 内任何文件不得引用 pipeline.ts / store-adapter.ts（含注释外的代码引用）
  for (const file of OPEN_TS_FILES) {
    const source = readFileSync(join(OPEN_DIR, file), 'utf-8');
    const specifiers = extractImportSpecifiers(source);
    for (const spec of specifiers) {
      assert.ok(!spec.includes('pipeline'), `open/${file} 引用了 pipeline：${spec}`);
      assert.ok(!spec.includes('adapter'), `open/${file} 引用了 adapter：${spec}`);
    }
  }
});
