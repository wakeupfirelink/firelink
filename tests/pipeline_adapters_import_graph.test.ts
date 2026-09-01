/**
 * 记忆引擎内核 36.2 · L0 适配器层 import 图静态检查
 * ---------------------------------------------------------------
 * 验收点（36 施工案 36.2，镜像 36.1 import 图测试规则）：
 * - open/adapters/ 自包含：所有 import 必须解析到 open/ 树内（含
 *   adapters 互引与 ../structure.js 等 open 顶层件）或 node: 内置
 *   （零 npm 外部依赖 = 零外部协议风险；零闭源依赖 = P0 一键 carve-out 预留）
 * - 适配器源码零闭源符号（store / 闭源模块名 / 自愈与定位器资产词）
 * - MIT license header 全覆盖（SPDX + 项目名 + 开源边界声明）
 * - 8 个适配器文件齐全，与统一注册表静态引用一一对应
 *
 * 本文件同时是可独立运行的检查脚本：
 *   node dist/tests/pipeline_adapters_import_graph.test.js
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
const ADAPTERS_DIR = join(OPEN_DIR, 'adapters');

/** 适配器层源文件清单（含子目录时 readdirSync 顶层 .ts 即全部） */
const ADAPTER_TS_FILES = readdirSync(ADAPTERS_DIR).filter((f) => f.endsWith('.ts'));

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

test('import 图：适配器层文件清单完整（3 公共件 + 8 适配器）', () => {
  const expected = [
    // 公共件
    'common.ts',
    'zip.ts',
    'registry.ts',
    // 8 适配器（7 开源 + 1 闭源接入位）
    'chatgpt.ts',
    'claude.ts',
    'characterai.ts',
    'txt-docx.ts',
    'st-chatlog.ts',
    'local-web.ts',
    'screenshot.ts',
    'qq-export.ts',
  ];
  assert.deepEqual([...ADAPTER_TS_FILES].sort(), [...expected].sort());
});

test('import 图：adapters/ 全部 import 解析到 open/ 树内或 node: 内置（零闭源零 npm）', () => {
  assert.ok(ADAPTER_TS_FILES.length >= 11);
  for (const file of ADAPTER_TS_FILES) {
    const fullPath = join(ADAPTERS_DIR, file);
    const source = readFileSync(fullPath, 'utf-8');
    const specifiers = extractImportSpecifiers(source);
    for (const spec of specifiers) {
      // node: 内置 → OK
      if (spec.startsWith('node:')) continue;
      // 相对导入 → 必须落在 open/ 树内（adapters 互引与 open 顶层件均合法）
      if (spec.startsWith('.')) {
        const resolved = resolveSpecifier(fullPath, spec);
        assert.ok(resolved, `adapters/${file}: import "${spec}" 无法解析`);
        assert.ok(
          resolved.startsWith(OPEN_DIR),
          `adapters/${file}: import "${spec}" 越界到 ${resolved}（闭源依赖零容忍）`,
        );
        continue;
      }
      // 其余一律视为 npm 外部依赖 → 违反零依赖铁律
      assert.fail(`adapters/${file}: 检测到 npm 外部依赖 "${spec}"（适配器层必须零外部依赖）`);
    }
  }
});

test('import 图：adapters/ 源码零闭源符号（grep 复核）', () => {
  // 闭源符号黑名单（与 36.1 import 图测试同表）
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
  for (const file of ADAPTER_TS_FILES) {
    const source = readFileSync(join(ADAPTERS_DIR, file), 'utf-8');
    for (const symbol of forbidden) {
      assert.equal(
        source.includes(symbol),
        false,
        `adapters/${file} 出现闭源符号 "${symbol}"（开源边界违规）`,
      );
    }
  }
});

test('import 图：MIT license header 全覆盖（SPDX + 项目名 + 开源边界声明）', () => {
  for (const file of ADAPTER_TS_FILES) {
    const source = readFileSync(join(ADAPTERS_DIR, file), 'utf-8');
    assert.ok(source.includes('SPDX-License-Identifier: MIT'), `adapters/${file} 缺 MIT header`);
    assert.ok(source.includes('传火'), `adapters/${file} header 应含项目名`);
    // 36 施工案 36.2：header 需声明自包含开源边界
    assert.ok(
      source.includes('open/adapters') || source.includes('自包含'),
      `adapters/${file} header 应声明开源边界（自包含）`,
    );
  }
});

test('import 图：8 适配器文件与统一注册表静态引用一一对应', () => {
  const registrySource = readFileSync(join(ADAPTERS_DIR, 'registry.ts'), 'utf-8');
  // 注册名 → 适配器导出对象名（文件名横线转 camelCase）
  const camelNames: Record<string, string> = {
    chatgpt: 'chatgptAdapter',
    claude: 'claudeAdapter',
    characterai: 'characteraiAdapter',
    'txt-docx': 'txtDocxAdapter',
    'st-chatlog': 'stChatlogAdapter',
    'local-web': 'localWebAdapter',
    screenshot: 'screenshotAdapter',
    'qq-export': 'qqExportAdapter',
  };
  const adapters: Array<{ file: string; name: string }> = [
    { file: 'chatgpt.ts', name: 'chatgpt' },
    { file: 'claude.ts', name: 'claude' },
    { file: 'characterai.ts', name: 'characterai' },
    { file: 'txt-docx.ts', name: 'txt-docx' },
    { file: 'st-chatlog.ts', name: 'st-chatlog' },
    { file: 'local-web.ts', name: 'local-web' },
    { file: 'screenshot.ts', name: 'screenshot' },
    { file: 'qq-export.ts', name: 'qq-export' },
  ];
  for (const a of adapters) {
    const source = readFileSync(join(ADAPTERS_DIR, a.file), 'utf-8');
    // 适配器文件声明注册名
    assert.ok(
      source.includes(`name: '${a.name}'`),
      `adapters/${a.file} 应声明注册名 name: '${a.name}'`,
    );
    // 注册表静态引用该文件（import + 表项缺一不可）
    assert.ok(
      registrySource.includes(`from './${a.file.replace(/\.ts$/, '.js')}'`),
      `registry.ts 应 import './${a.file.replace(/\.ts$/, '.js')}'`,
    );
    const objName = camelNames[a.name];
    assert.ok(
      objName !== undefined && registrySource.includes(`${objName}.name`),
      `registry.ts 应将 ${a.file} 的适配器（${objName}）挂入注册表`,
    );
  }
});
