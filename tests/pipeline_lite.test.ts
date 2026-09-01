/**
 * 记忆引擎内核 36.1 · lite 总装测试
 * ---------------------------------------------------------------
 * 覆盖验收点：
 * - 无 key 降级路径全链跑通（验收核心）：无任何 LLM key 时
 *   lite 全链产出纯结构化记忆包三格式，不报错
 * - mock provider 全链：LLM 分角色 + L3 提纯 + 三格式
 * - JSON 配置路径输入
 * - 三格式落盘
 * - degraded 降级标记
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { runLitePipeline } from '../src/lite.js';
import type { MessageRole } from '../src/structure.js';
import { MockLLMProvider, loadHostSample, makeSyntheticChat, makeTestDir, cleanupTestDir, FAKE_SENSITIVE } from './pipeline_test_helpers.js';

const ALIASES: Record<string, MessageRole> = { 星见雅: 'assistant', 测试用户: 'user' };

/* ================================================================
 * 一、无 key 降级全链（验收标准 3：纯结构化记忆包三格式）
 * ===============================================================*/

test('lite：无 key 降级全链——纯结构化记忆包三格式产出，全程不报错', async () => {
  const input = makeSyntheticChat({
    pairs: 5,
    withSensitive: true,
    withNoise: true,
    withDuplicateRound: true,
  });
  const r = await runLitePipeline({
    input,
    structure: { roleAliases: ALIASES, baseYear: 2026 },
  });

  // 降级标记
  assert.equal(r.degraded, true);
  assert.deepEqual(r.degradationReasons, ['no_llm_provider']);

  // L1 生效（去重 + 噪音 + 脱敏）
  assert.ok(r.clean.stats.dedupRemoved > 0, '两轮重复段应被去重');
  assert.ok(r.clean.stats.noiseRemoved > 0, '钻石气泡应被过滤');
  assert.ok(Object.keys(r.clean.stats.redactionHits).length >= 2, '敏感样例应被脱敏');

  // L2 结构化（段头确定性解析，无 LLM）
  assert.ok(r.messages.length >= 10);
  assert.ok(r.messages.every((m) => typeof m.ts === 'number' || m.ts === null));
  assert.ok(r.messages.some((m) => m.role === 'assistant'));
  assert.ok(r.messages.some((m) => m.role === 'user'));
  const joined = r.messages.map((m) => m.text).join('\n');
  assert.equal(joined.includes(FAKE_SENSITIVE.phone), false);
  assert.equal(joined.includes(FAKE_SENSITIVE.idCard18), false);

  // L3 跳过（降级）
  assert.equal(r.distill.skipped, true);
  assert.equal(r.distill.skipReason, 'no_provider');

  // 三格式产出（纯结构化）
  assert.ok(r.mempack.wakeupMem.includes('"type":"mempack-meta"'));
  const msgLines = r.mempack.messages.trim().split('\n');
  assert.equal(msgLines.length, r.messages.length);
  assert.ok(r.mempack.markdown.includes('## '));
});

test('lite：无 key 纯文本输入（无消息头）→ unlabeled 待标降级', async () => {
  const r = await runLitePipeline({ input: '第一行\n第二行\n第三行' });
  assert.equal(r.degraded, true);
  assert.equal(r.messages.length, 3);
  assert.ok(r.messages.every((m) => m.role === 'unlabeled' && m.meta!.pendingLabel === true));
  assert.equal(r.distill.skipped, true);
});

test('lite：withDistill:false 显式关闭 L3（有 provider 也不跑）', async () => {
  const mock = new MockLLMProvider();
  const r = await runLitePipeline({
    input: makeSyntheticChat({ pairs: 3 }),
    provider: mock,
    withDistill: false,
  });
  assert.equal(r.degraded, false);
  assert.equal(r.distill.skipped, true);
  assert.equal(r.distill.skipReason, 'disabled');
});

/* ================================================================
 * 二、mock provider 全链
 * ===============================================================*/

test('lite：mock provider 全链（L1 清洗 + L2 结构化 + L3 提纯 + 三格式）', async () => {
  const mock = new MockLLMProvider();
  const input = makeSyntheticChat({ pairs: 6, withSensitive: true, withNoise: true });
  const r = await runLitePipeline({
    input,
    provider: mock,
    structure: { roleAliases: ALIASES, baseYear: 2026 },
    llmRedactReview: true, // LLM 脱敏复核也走 mock
  });
  assert.equal(r.degraded, false);
  // L2：段头确定性解析为主（无纯文本 LLM 分角色调用）
  assert.ok(r.messages.length >= 12);
  // L3 产出三路
  assert.equal(r.distill.skipped, false);
  assert.ok(r.distill.weeklySummaries.length >= 1);
  assert.ok(r.distill.longTerm.length >= 1);
  assert.ok(r.distill.notebook.length >= 1);
  assert.ok(r.distill.profile.length >= 1);
  // mock 被调用（周摘要/锚点/分层/复核）
  assert.ok(mock.calls.length >= 4);
});

test('lite：结构化源输入（RawMessage[]）全链降级（无 key 仍结构化）', async () => {
  const r = await runLitePipeline({
    input: [
      { role: 'user', text: '你好', ts: 1760000000000 },
      { role: 'assistant', text: '我在', ts: 1760000001000 },
    ],
  });
  assert.equal(r.degraded, true);
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].role, 'user'); // ref 复原
  assert.equal(r.messages[0].ts, 1760000000000);
});

/* ================================================================
 * 三、配置与落盘
 * ===============================================================*/

test('lite：JSON 配置文件路径输入（config: string）', async () => {
  const dir = makeTestDir('lite_config');
  const configPath = `${dir}/test_lite_config.json`;
  writeFileSync(
    configPath,
    JSON.stringify({ noiseRules: [{ type: 'contains', pattern: '专属噪音' }] }),
    'utf-8',
  );
  const r = await runLitePipeline({
    input: ['正常消息', '这是专属噪音内容'],
    config: configPath,
  });
  assert.equal(r.clean.segments.length, 1);
  cleanupTestDir('lite_config');
});

test('lite：三格式落盘（outputDir + test_ 前缀）', async () => {
  const dir = makeTestDir('lite_output');
  const r = await runLitePipeline({
    input: makeSyntheticChat({ pairs: 4 }),
    structure: { roleAliases: ALIASES, baseYear: 2026 },
    outputDir: dir,
    filePrefix: 'test_lite',
  });
  assert.ok(r.mempack.files);
  assert.ok(existsSync(r.mempack.files!.wakeupMem));
  assert.ok(existsSync(r.mempack.files!.messages));
  assert.ok(existsSync(r.mempack.files!.markdown));
  const first = JSON.parse(readFileSync(r.mempack.files!.wakeupMem, 'utf-8').split('\n')[0]);
  assert.equal(first.stats.messageCount, r.messages.length);
  cleanupTestDir('lite_output');
});

/* ================================================================
 * 四、宿主样本全链（无 key 降级 + 可读时间线）
 * ===============================================================*/

test('lite：宿主样本小片段无 key 全链（去重/脱敏/结构化/三格式）', { skip: !loadHostSample() }, async () => {
  const sample = loadHostSample()!;
  const r = await runLitePipeline({
    input: sample,
    structure: { roleAliases: ALIASES, baseYear: 2026 },
  });
  assert.equal(r.degraded, true);
  // 两轮重复段去重
  assert.ok(r.clean.stats.dedupRemoved > 30, `dedupRemoved=${r.clean.stats.dedupRemoved}`);
  // 钻石气泡清零
  assert.ok(!r.messages.some((m) => m.text.includes('钻石余额不足')));
  // 时间线可读（markdown 有日期分组）
  assert.ok(r.mempack.markdown.includes('## 2026-06-13'));
  // 三格式消息数一致
  const msgLines = r.mempack.messages.trim().split('\n').length;
  assert.equal(msgLines, r.messages.length);
});
