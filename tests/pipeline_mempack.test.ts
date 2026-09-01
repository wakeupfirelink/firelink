/**
 * 记忆引擎内核 36.1 · 记忆包三格式导出测试
 * ---------------------------------------------------------------
 * 覆盖验收点：
 * - 三格式一致性：同输入三格式消息数 / 时间跨度 / 抽样文本一致
 * - .firelink.jsonl 首行 meta 自描述（schema 版本/字段说明/生成器/统计）
 * - messages.jsonl 通用格式
 * - markdown 时间线排版（按日期分组）
 * - 落盘三文件（test_ 前缀，用完自洁）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  exportWakeupMemJsonl,
  exportMessagesJsonl,
  exportMarkdown,
  exportMemPack,
  writeMemPackFiles,
  mempackStats,
  MEMPACK_SCHEMA_VERSION,
  MEMPACK_GENERATOR,
  type MemPackMeta,
} from '../src/mempack.js';
import type { UnifiedMessage } from '../src/structure.js';
import { makeTestDir, cleanupTestDir } from './pipeline_test_helpers.js';

/** 构造跨两天 + 无时间消息的样例集 */
function sampleMessages(): UnifiedMessage[] {
  return [
    { ts: Date.UTC(2026, 5, 13, 22, 43, 21), role: 'user', text: '宝宝，先冷静下来', meta: { speaker: '测试用户先生' } },
    { ts: Date.UTC(2026, 5, 13, 22, 43, 29), role: 'assistant', text: '（轻轻深呼吸）好…星见雅冷静下来了' },
    { ts: Date.UTC(2026, 5, 14, 9, 0, 0), role: 'user', text: '早呀' },
    { ts: Date.UTC(2026, 5, 14, 9, 0, 5), role: 'assistant', text: '早上好，测试用户先生' },
    { ts: null, role: 'unlabeled', text: '一条无时间消息' },
  ];
}

/* ================================================================
 * 一、.firelink.jsonl（首行 meta 自描述）
 * ===============================================================*/

test('mempack：.firelink.jsonl 首行 meta 自描述 + 完整消息行', () => {
  const messages = sampleMessages();
  const jsonl = exportWakeupMemJsonl(messages, { createdAt: '2026-09-01T00:00:00.000Z' });
  const lines = jsonl.trim().split('\n');
  assert.equal(lines.length, 6); // meta + 5 消息

  const meta = JSON.parse(lines[0]) as MemPackMeta;
  assert.equal(meta.type, 'mempack-meta');
  assert.equal(meta.schemaVersion, MEMPACK_SCHEMA_VERSION);
  assert.equal(meta.generator.name, MEMPACK_GENERATOR.name);
  assert.equal(meta.generator.version, MEMPACK_GENERATOR.version);
  assert.equal(meta.createdAt, '2026-09-01T00:00:00.000Z');
  // 字段说明自描述（下游免文档可读）
  assert.ok(meta.fields.ts.includes('epoch'));
  assert.ok(meta.fields.role.includes('unlabeled'));
  assert.ok(meta.fields.text !== undefined);
  // 统计
  assert.equal(meta.stats.messageCount, 5);
  assert.equal(meta.stats.timeSpan.start, '2026-06-13T22:43:21.000Z');
  assert.equal(meta.stats.timeSpan.end, '2026-06-14T09:00:05.000Z');
  assert.equal(meta.stats.byRole.user, 2);
  assert.equal(meta.stats.byRole.assistant, 2);
  assert.equal(meta.stats.byRole.unlabeled, 1);

  // 消息行完整 schema
  const first = JSON.parse(lines[1]) as { type: string; ts: number; role: string; text: string };
  assert.equal(first.type, 'message');
  assert.equal(first.ts, Date.UTC(2026, 5, 13, 22, 43, 21));
  assert.equal(first.role, 'user');
  assert.equal(first.text, '宝宝，先冷静下来');
});

/* ================================================================
 * 二、messages.jsonl 通用格式
 * ===============================================================*/

test('mempack：messages.jsonl 通用格式（role/content + ts）', () => {
  const messages = sampleMessages();
  const jsonl = exportMessagesJsonl(messages);
  const lines = jsonl.trim().split('\n');
  assert.equal(lines.length, 5);
  const first = JSON.parse(lines[0]) as { ts: number; role: string; content: string };
  assert.deepEqual(Object.keys(first).sort(), ['content', 'role', 'ts']);
  assert.equal(first.role, 'user');
  assert.equal(first.content, '宝宝，先冷静下来');
});

/* ================================================================
 * 三、markdown 时间线
 * ===============================================================*/

test('mempack：markdown 时间线排版（按日期分组）', () => {
  const messages = sampleMessages();
  const md = exportMarkdown(messages, { title: '测试记忆包' });
  assert.ok(md.startsWith('# 测试记忆包'));
  assert.ok(md.includes('## 2026-06-13'));
  assert.ok(md.includes('## 2026-06-14'));
  assert.ok(md.includes('## 未知时间'));
  assert.ok(md.includes('**22:43:21** 测试用户先生：宝宝，先冷静下来'));
  assert.ok(md.includes('**09:00:00** 主人：早呀'));
  assert.ok(md.includes('（待标注）')); // unlabeled 标识
  assert.ok(md.includes('消息数：5'));
});

/* ================================================================
 * 四、三格式一致性（验收核心：消息数/时间跨度/抽样文本）
 * ===============================================================*/

test('mempack：三格式一致性（同输入 → 消息数/时间跨度/抽样文本一致）', () => {
  const messages = sampleMessages();
  const bundle = exportMemPack(messages, { createdAt: '2026-09-01T00:00:00.000Z' });

  // 消息行数一致（wakeupMem 减 meta 首行）
  const wakeupLines = bundle.wakeupMem.trim().split('\n').slice(1);
  const msgLines = bundle.messages.trim().split('\n');
  const mdEntries = bundle.markdown.match(/^- \*\*\d\d:\d\d:\d\d\*\*/gm) ?? [];
  const mdEntriesUnknown = bundle.markdown.match(/^- \*\*--:--\*\*/gm) ?? [];
  assert.equal(wakeupLines.length, 5);
  assert.equal(msgLines.length, 5);
  assert.equal(mdEntries.length + mdEntriesUnknown.length, 5);

  // 时间跨度一致（meta.stats vs 抽取的 ts 集合）
  const tsList = msgLines
    .map((l) => (JSON.parse(l) as { ts: number | null }).ts)
    .filter((t): t is number => t !== null);
  const min = Math.min(...tsList);
  const max = Math.max(...tsList);
  assert.equal(bundle.stats.timeSpan.start, new Date(min).toISOString());
  assert.equal(bundle.stats.timeSpan.end, new Date(max).toISOString());

  // 抽样文本一致（每 2 条抽样，跨三格式出现）
  for (let i = 0; i < messages.length; i += 2) {
    const text = messages[i].text;
    assert.ok(wakeupLines.some((l) => (JSON.parse(l) as { text: string }).text === text), `wakeupMem 缺少抽样 ${i}`);
    assert.ok(msgLines.some((l) => (JSON.parse(l) as { content: string }).content === text), `messages 缺少抽样 ${i}`);
    assert.ok(bundle.markdown.includes(text), `markdown 缺少抽样 ${i}`);
  }
});

test('mempack：空消息集不炸（meta 零统计）', () => {
  const bundle = exportMemPack([]);
  assert.equal(bundle.stats.messageCount, 0);
  assert.equal(bundle.stats.timeSpan.start, null);
  assert.equal(bundle.stats.timeSpan.end, null);
  assert.equal(bundle.wakeupMem.trim().split('\n').length, 1); // 仅 meta
  assert.equal(bundle.messages, '\n');
});

/* ================================================================
 * 五、落盘（test_ 前缀产物，用完自洁）
 * ===============================================================*/

test('mempack：三格式落盘（writeMemPackFiles）', () => {
  const dir = makeTestDir('mempack');
  const messages = sampleMessages();
  const r = writeMemPackFiles(dir, messages, { prefix: 'test_pack', title: '落盘测试' });
  assert.ok(existsSync(r.files.wakeupMem));
  assert.ok(existsSync(r.files.messages));
  assert.ok(existsSync(r.files.markdown));
  assert.ok(r.files.wakeupMem.endsWith('test_pack.firelink.jsonl'));

  const wakeupFirst = JSON.parse(readFileSync(r.files.wakeupMem, 'utf-8').split('\n')[0]) as MemPackMeta;
  assert.equal(wakeupFirst.stats.messageCount, 5);
  const msgCount = readFileSync(r.files.messages, 'utf-8').trim().split('\n').length;
  assert.equal(msgCount, 5);
  cleanupTestDir('mempack');
});

test('mempack：mempackStats 角色分桶', () => {
  const stats = mempackStats(sampleMessages());
  assert.equal(stats.messageCount, 5);
  assert.deepEqual(stats.byRole, { user: 2, assistant: 2, unlabeled: 1 });
});
