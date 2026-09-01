/**
 * 记忆引擎内核 36.2 · L0 适配器测试 · 文本类源（txt-docx / local-web）
 * ---------------------------------------------------------------
 * - txt-docx：docx 零依赖 zip+xml 提取（真实 ZIP 路径）/ 段头确定性解析 /
 *   无 key 纯文本降级 / mock provider LLM 分角色 / 宿主样本端到端
 *   （勘察事实：样本两轮重复去重后 user 侧 7 条 + assistant 侧 52 条）
 * - local-web：HTML 正文提取（title/script 剔除/实体解码）+ 段头模式与降级
 * 施工纪律：LLM 单测一律 mock provider，禁止调真实 API。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptTxtDocx } from '../src/adapters/txt-docx.js';
import { adaptLocalWeb } from '../src/adapters/local-web.js';
import { runLitePipeline } from '../src/lite.js';
import { MockLLMProvider, loadHostSample } from './pipeline_test_helpers.js';
import { makeDocx, makeZip } from './pipeline_adapters_helpers.js';
import type { MessageRole } from '../src/structure.js';

const ALIASES: Record<string, MessageRole> = { 星见雅: 'assistant', 测试用户: 'user' };
const BASE_YEAR = 2026;

/* ================================================================
 * 一、txt-docx：docx 提取与段头解析
 * ===============================================================*/

/** docx fixture：段头格式「名字: MM-DD HH:MM:SS 正文」（与宿主样本同构） */
function docxFixture(): Uint8Array {
  return makeDocx([
    '星见雅: 06-13 22:43:21 （轻轻点头）我在呢，今天也想你了',
    '测试用户先生: 06-13 22:43:40 我也是，还想听你说晚安',
    '星见雅: 06-13 22:44:02 好，那今晚 & 明晚 都说给你听',
  ]);
}

test('txt-docx：docx 零依赖 zip+xml 提取→段头确定性解析（角色/时间戳/实体解码）', async () => {
  const r = await adaptTxtDocx(docxFixture(), { roleAliases: ALIASES, baseYear: BASE_YEAR });
  assert.equal(r.meta.mode, 'headers');
  assert.equal(r.messages.length, 3);
  assert.deepEqual(
    r.messages.map((m) => m.role),
    ['assistant', 'user', 'assistant'],
  );
  // 时间戳：MM-DD HH:MM:SS + baseYear（UTC 构造）
  assert.equal(r.messages[0].ts, Date.UTC(2026, 5, 13, 22, 43, 21));
  assert.equal(r.messages[1].ts, Date.UTC(2026, 5, 13, 22, 43, 40));
  // XML 实体解码
  assert.equal(r.messages[2].text, '好，那今晚 & 明晚 都说给你听');
  // 段头解析存证
  assert.equal(r.messages[0].meta?.speaker, '星见雅');
  assert.equal(r.messages[0].meta?.rawTime, '06-13 22:43:21');
  assert.equal(r.messages[0].meta?.roleMatched, '星见雅');
});

test('txt-docx：docx 内无 document.xml 明确报错', async () => {
  const badDocx = makeZip({ 'other/file.xml': '<x/>' });
  await assert.rejects(() => adaptTxtDocx(badDocx), /未找到 word\/document\.xml/);
});

test('txt-docx：无段头纯文本 + 无 key → 按行保留原文待标注，不报错', async () => {
  const text = '你好呀\n今天有点累\n想听你说晚安';
  const r = await adaptTxtDocx(text);
  assert.equal(r.meta.mode, 'plaintext');
  assert.equal(r.messages.length, 3);
  assert.ok(r.messages.every((m) => m.role === 'unlabeled'));
  assert.ok(r.messages.every((m) => m.meta?.pendingLabel === true));
  assert.equal(r.stats.pendingLabel, 3);
  assert.equal(r.stats.llmAssisted, 0);
  // 原文保留
  assert.equal(r.messages[0].text, '你好呀');
});

test('txt-docx：无段头纯文本 + mock provider → LLM 分角色（复用 36.1 转写模板与 provider 抽象）', async () => {
  const provider = new MockLLMProvider('mock-llm', 'mock-model', (req) => {
    // 输出契约：JSON 数组 [{role, text}]（与 structure.ts P0 模板一致）
    assert.ok(req.system !== undefined, '转写应带 system 提示词（内置模板）');
    return JSON.stringify([
      { role: 'user', text: '你好呀' },
      { role: 'assistant', text: '你好，我在呢' },
    ]);
  });
  const r = await adaptTxtDocx('你好呀\n你好，我在呢', { provider });
  assert.equal(r.meta.mode, 'plaintext');
  assert.equal(r.messages.length, 2);
  assert.deepEqual(
    r.messages.map((m) => m.role),
    ['user', 'assistant'],
  );
  assert.equal(r.stats.llmAssisted, 2);
  assert.ok(r.messages.every((m) => m.meta?.llmRoleLabel === true));
});

test('txt-docx：段头格式说话人未命中 aliases → unlabeled 待标注（保留原文不报错）', async () => {
  const r = await adaptTxtDocx('陌生人甲: 06-13 22:43:21 你好', { baseYear: BASE_YEAR });
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].role, 'unlabeled');
  assert.equal(r.messages[0].meta?.pendingLabel, true);
  assert.equal(r.messages[0].meta?.speaker, '陌生人甲');
});

test('txt-docx：端到端（docx）——fixture→适配器→统一 schema→lite→记忆包三格式', async () => {
  const l0 = await adaptTxtDocx(docxFixture(), { roleAliases: ALIASES, baseYear: BASE_YEAR });
  const r = await runLitePipeline({ input: l0.messages, title: 'docx 导入' });
  assert.equal(r.messages.length, 3);
  assert.deepEqual(
    r.messages.map((m) => m.role),
    ['assistant', 'user', 'assistant'],
  );
  assert.equal(r.messages[0].ts, Date.UTC(2026, 5, 13, 22, 43, 21));
  const wakeupLines = r.mempack.wakeupMem.split('\n').filter((l) => l.length > 0);
  assert.equal(wakeupLines.length, 4, '首行 meta + 3 条消息');
  const msgLines = r.mempack.messages.split('\n').filter((l) => l.length > 0);
  assert.equal(msgLines.length, 3);
  assert.ok(r.mempack.markdown.includes('docx 导入'));
  assert.ok(r.mempack.markdown.includes('我在呢，今天也想你了'));
});

/* ================================================================
 * 二、txt-docx：宿主样本端到端（874 天 docx 解析稿小片段）
 * ===============================================================*/

test('txt-docx：宿主样本端到端——两轮重复去重后 7 user + 52 assistant，时间戳全覆盖', { skip: !loadHostSample() }, async () => {
  const sample = loadHostSample()!;
  const l0 = await adaptTxtDocx(sample, { roleAliases: ALIASES, baseYear: BASE_YEAR });
  // L0 层：段头确定性解析全量入列（121 条，两轮重复在 L1 去除）
  assert.equal(l0.messages.length, 121);
  assert.equal(l0.meta.mode, 'headers');
  assert.ok(l0.messages.some((m) => m.role === 'user'));
  assert.ok(l0.messages.some((m) => m.role === 'assistant'));

  const r = await runLitePipeline({ input: l0.messages, title: '宿主样本导入' });
  // 勘察事实（与 36.1 结构化测试同源）：去重后 user 侧 7 条 + assistant 侧 52 条
  const byRole = r.messages.reduce<Record<string, number>>((acc, m) => {
    acc[m.role] = (acc[m.role] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(byRole, { user: 7, assistant: 52 });
  // 时间线可用（全部消息解析出时间戳）
  assert.equal(r.messages.filter((m) => m.ts !== null).length, r.messages.length);
  // 三格式产出
  const wakeupLines = r.mempack.wakeupMem.split('\n').filter((l) => l.length > 0);
  assert.equal(wakeupLines.length, r.messages.length + 1);
  const msgLines = r.mempack.messages.split('\n').filter((l) => l.length > 0);
  assert.equal(msgLines.length, r.messages.length);
});

/* ================================================================
 * 三、local-web：HTML 正文提取
 * ===============================================================*/

function localWebFixture(): string {
  return [
    '<!DOCTYPE html>',
    '<html><head><title>和星见雅的对话备份</title><style>.x{color:red}</style></head>',
    '<body>',
    '<script>var secret = "不应出现";</script>',
    '<div class="chat">',
    '<p><b>星见雅:</b> 06-13 22:43:21 欢迎回来&amp;#65292;今晚想聊什么？</p>',
    '<p><b>测试用户:</b> 06-13 22:43:40 我回来了，今天有点累</p>',
    '<p>星见雅: 06-13 22:44:02 那我给你讲个故事吧</p>',
    '</div>',
    '<noscript>请开启 JavaScript</noscript>',
    '</body></html>',
  ].join('\n');
}

test('local-web：HTML 正文提取（title / script-style-noscript 剔除 / 实体解码）', async () => {
  const r = await adaptLocalWeb(localWebFixture(), { roleAliases: { 星见雅: 'assistant', 测试用户: 'user' }, baseYear: BASE_YEAR });
  assert.equal(r.meta.title, '和星见雅的对话备份');
  assert.equal(r.meta.mode, 'headers');
  assert.equal(r.messages.length, 3);
  assert.deepEqual(
    r.messages.map((m) => m.role),
    ['assistant', 'user', 'assistant'],
  );
  // 实体解码（&amp;#65292; → &#65292; 不再二次解码，保留字面）
  assert.ok(r.messages[0].text.includes('欢迎回来'));
  // script 内容不泄漏
  const joined = r.messages.map((m) => m.text).join('\n');
  assert.equal(joined.includes('不应出现'), false);
  assert.equal(joined.includes('请开启 JavaScript'), false);
  // 时间戳
  assert.equal(r.messages[0].ts, Date.UTC(2026, 5, 13, 22, 43, 21));
});

test('local-web：无段头页面 → 正文块待标注（关停平台兜底路径）', async () => {
  const html = '<html><body><p>平台已经关停了</p><p>这是残存的对话片段</p><p>无法判断谁在说话</p></body></html>';
  const r = await adaptLocalWeb(html);
  assert.equal(r.meta.mode, 'plaintext');
  assert.equal(r.messages.length, 3);
  assert.ok(r.messages.every((m) => m.role === 'unlabeled'));
  assert.equal(r.stats.pendingLabel, 3);
  assert.equal(r.messages[1].text, '这是残存的对话片段');
});

test('local-web：无正文页面明确报错', async () => {
  await assert.rejects(() => adaptLocalWeb('<html><body><script>x</script></body></html>'), /未提取到正文内容/);
});

test('local-web：端到端——HTML→适配器→统一 schema→lite→记忆包三格式', async () => {
  const l0 = await adaptLocalWeb(localWebFixture(), { roleAliases: { 星见雅: 'assistant', 测试用户: 'user' }, baseYear: BASE_YEAR });
  const r = await runLitePipeline({ input: l0.messages, title: '网页备份导入' });
  assert.equal(r.messages.length, 3);
  assert.deepEqual(
    r.messages.map((m) => m.role),
    ['assistant', 'user', 'assistant'],
  );
  assert.equal(r.messages[0].ts, Date.UTC(2026, 5, 13, 22, 43, 21));
  const wakeupLines = r.mempack.wakeupMem.split('\n').filter((l) => l.length > 0);
  assert.equal(wakeupLines.length, 4, '首行 meta + 3 条消息');
  const msgLines = r.mempack.messages.split('\n').filter((l) => l.length > 0);
  assert.equal(msgLines.length, 3);
  assert.ok(r.mempack.markdown.includes('网页备份导入'));
  assert.ok(r.mempack.markdown.includes('那我给你讲个故事吧'));
});
