/**
 * 记忆引擎内核 36.2 · L0 适配器测试 · 结构化源
 * ---------------------------------------------------------------
 * 覆盖：chatgpt / claude / characterai / st-chatlog 四个结构化适配器
 * - fixture 按各平台官方公开格式构造（敏感字段一律假数据）
 * - 每适配器端到端：fixture → 适配器 → 统一 schema → runLitePipeline
 *   （lite 路径）→ 记忆包三格式，断言消息数 / 角色 / 时间戳
 * 施工纪律：零真实 API 调用；Character.AI 走真实 ZIP 解压路径（内存构造 ZIP）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptChatGPT } from '../src/adapters/chatgpt.js';
import { adaptClaude } from '../src/adapters/claude.js';
import { adaptCharacterAI } from '../src/adapters/characterai.js';
import { adaptStChatlog } from '../src/adapters/st-chatlog.js';
import { runLitePipeline } from '../src/lite.js';
import { makeZip } from './pipeline_adapters_helpers.js';
import type { L0Result } from '../src/adapters/common.js';

/* ================================================================
 * 一、ChatGPT 官方 conversations.json
 * ===============================================================*/

/** 官方格式 fixture：mapping 消息树（含重 roll 分支 / tool 节点 / 空 system 节点） */
function chatgptFixture(): string {
  return JSON.stringify([
    {
      title: '关于记忆的话题',
      create_time: 1718275200,
      update_time: 1718275400,
      current_node: 'n-d',
      mapping: {
        'n-root': {
          id: 'n-root',
          message: { id: 'm0', author: { role: 'system' }, create_time: 1718275190, content: { content_type: 'text', parts: [] } },
          parent: null,
          children: ['n-a'],
        },
        'n-a': {
          id: 'n-a',
          message: { id: 'm1', author: { role: 'user' }, create_time: 1718275200, content: { content_type: 'text', parts: ['你还记得我们第一次聊天的内容吗？'] } },
          parent: 'n-root',
          children: ['n-b', 'n-b2'],
        },
        'n-b': {
          id: 'n-b',
          message: { id: 'm2', author: { role: 'assistant' }, create_time: 1718275230, content: { content_type: 'text', parts: ['当然记得，', '那天你问了我关于时间线的问题。'] } },
          parent: 'n-a',
          children: ['n-c'],
        },
        'n-b2': {
          id: 'n-b2',
          message: { id: 'm3', author: { role: 'assistant' }, create_time: 1718275240, content: { content_type: 'text', parts: ['（重 roll 版本）当然记得呀。'] } },
          parent: 'n-a',
          children: [],
        },
        'n-c': {
          id: 'n-c',
          message: { id: 'm4', author: { role: 'user' }, create_time: 1718275250, content: { content_type: 'text', parts: ['那把这些记忆保存下来吧'] } },
          parent: 'n-b',
          children: ['n-tool', 'n-d'],
        },
        'n-tool': {
          id: 'n-tool',
          message: { id: 'm5', author: { role: 'tool' }, create_time: 1718275255, content: { content_type: 'text', parts: ['internal-tool-call'] } },
          parent: 'n-c',
          children: [],
        },
        'n-d': {
          id: 'n-d',
          message: { id: 'm6', author: { role: 'assistant' }, create_time: 1718275260, content: { content_type: 'text', parts: ['好的，我会一直记得。'] } },
          parent: 'n-c',
          children: [],
        },
      },
    },
  ]);
}

test('chatgpt：mapping 消息树 DFS 遍历→线性序列（分支入列 / tool 与空消息跳过 / parts 拼接 / 秒→ms）', async () => {
  const r = await adaptChatGPT(chatgptFixture());
  // 树序：A(user) → B(assistant) → C(user) → tool 跳过 → D(assistant) → B2(assistant 重 roll)
  assert.equal(r.messages.length, 5);
  assert.deepEqual(
    r.messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant', 'assistant'],
  );
  // 多 parts 拼接
  assert.equal(r.messages[1].text, '当然记得，\n那天你问了我关于时间线的问题。');
  // 时间戳：epoch 秒 → ms
  assert.equal(r.messages[0].ts, 1718275200000);
  assert.equal(r.messages[3].ts, 1718275260000);
  // 跳过统计：空 system + tool = 2
  assert.equal(r.stats.skipped, 2);
  assert.deepEqual(r.stats.byRole, { user: 2, assistant: 3 });
  // meta 存证
  assert.equal(r.messages[0].meta?.conversationTitle, '关于记忆的话题');
  assert.equal(r.messages[0].meta?.source, 'chatgpt');
});

test('chatgpt：current-path 模式只取当前主路径（重 roll 旁支不入列）', async () => {
  const r = await adaptChatGPT(chatgptFixture(), { chatgptMode: 'current-path' });
  assert.equal(r.messages.length, 4);
  assert.deepEqual(
    r.messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant'],
  );
  assert.equal(r.messages.some((m) => m.text.includes('重 roll')), false);
});

test('chatgpt：非官方格式输入明确报错', async () => {
  await assert.rejects(
    () => adaptChatGPT(JSON.stringify({ foo: 'bar' })),
    /未识别到会话数据/,
  );
});

test('chatgpt：端到端——适配器→统一 schema→lite→记忆包三格式', async () => {
  const l0 = await adaptChatGPT(chatgptFixture());
  const r = await runLitePipeline({ input: l0.messages, title: 'chatgpt 导入' });

  // 消息数 / 角色 / 时间戳经 lite 全链保持
  assert.equal(r.messages.length, 5);
  assert.deepEqual(
    r.messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant', 'assistant'],
  );
  assert.equal(r.messages[0].ts, 1718275200000);

  // 三格式产出一致
  const wakeupLines = r.mempack.wakeupMem.split('\n').filter((l) => l.length > 0);
  assert.equal(wakeupLines.length, 6, '首行 meta + 5 条消息');
  assert.equal(JSON.parse(wakeupLines[0]).type, 'mempack-meta');
  const msgLines = r.mempack.messages.split('\n').filter((l) => l.length > 0);
  assert.equal(msgLines.length, 5);
  assert.equal(JSON.parse(msgLines[0]).role, 'user');
  assert.equal(JSON.parse(msgLines[0]).content, '你还记得我们第一次聊天的内容吗？');
  assert.ok(r.mempack.markdown.includes('# chatgpt 导入'));
  assert.ok(r.mempack.markdown.includes('你还记得我们第一次聊天的内容吗？'));
});

/* ================================================================
 * 二、Claude 官方 conversations.json
 * ===============================================================*/

function claudeFixture(): string {
  return JSON.stringify([
    {
      uuid: 'conv-1',
      name: '日常对话',
      summary: '关于作息的闲聊',
      created_at: '2026-06-13T14:43:00.000Z',
      updated_at: '2026-06-13T14:44:00.000Z',
      chat_messages: [
        {
          uuid: 'cm-1',
          sender: 'human',
          text: '今天过得怎么样？',
          content: [{ type: 'text', text: '今天过得怎么样？' }],
          created_at: '2026-06-13T14:43:21.000Z',
        },
        {
          uuid: 'cm-2',
          sender: 'assistant',
          text: '',
          content: [{ type: 'text', text: '很好哦，一直在等你回来。' }],
          created_at: '2026-06-13T14:43:29.000Z',
        },
        {
          uuid: 'cm-3',
          sender: 'assistant',
          text: '   ',
          content: [],
          created_at: '2026-06-13T14:43:35.000Z',
        },
      ],
    },
    {
      uuid: 'conv-2',
      name: '第二条会话',
      chat_messages: [
        {
          uuid: 'cm-4',
          sender: 'human',
          text: '早上好',
          created_at: '2026-06-14T01:02:03.000Z',
        },
      ],
    },
  ]);
}

test('claude：chat_messages 直接映射（human→user / text 缺失走 content 块 / 空消息跳过 / ISO→ms）', async () => {
  const r = await adaptClaude(claudeFixture());
  assert.equal(r.messages.length, 3);
  assert.deepEqual(
    r.messages.map((m) => m.role),
    ['user', 'assistant', 'user'],
  );
  // text 为空 → content 块拼接
  assert.equal(r.messages[1].text, '很好哦，一直在等你回来。');
  // ISO 时间 → epoch ms
  assert.equal(r.messages[0].ts, Date.parse('2026-06-13T14:43:21.000Z'));
  assert.equal(r.messages[2].ts, Date.parse('2026-06-14T01:02:03.000Z'));
  // 空白消息跳过
  assert.equal(r.stats.skipped, 1);
  // 会话归属存证
  assert.equal(r.messages[0].meta?.conversationName, '日常对话');
  assert.equal(r.messages[2].meta?.conversationName, '第二条会话');
  assert.equal(r.messages[0].meta?.sender, 'human');
});

test('claude：端到端——适配器→统一 schema→lite→记忆包三格式', async () => {
  const l0 = await adaptClaude(claudeFixture());
  const r = await runLitePipeline({ input: l0.messages, title: 'claude 导入' });
  assert.equal(r.messages.length, 3);
  assert.deepEqual(
    r.messages.map((m) => m.role),
    ['user', 'assistant', 'user'],
  );
  assert.equal(r.messages[0].ts, Date.parse('2026-06-13T14:43:21.000Z'));
  const wakeupLines = r.mempack.wakeupMem.split('\n').filter((l) => l.length > 0);
  assert.equal(wakeupLines.length, 4, '首行 meta + 3 条消息');
  const msgLines = r.mempack.messages.split('\n').filter((l) => l.length > 0);
  assert.equal(msgLines.length, 3);
  assert.ok(r.mempack.markdown.includes('claude 导入'));
  assert.ok(r.mempack.markdown.includes('很好哦，一直在等你回来。'));
});

/* ================================================================
 * 三、Character.AI 官方导出 ZIP
 * ===============================================================*/

/** 官方三件套 fixture（假数据；<用户名>/data/ 目录层级 + src.raw_content 形态） */
function characteraiZipFixture(): Uint8Array {
  return makeZip({
    'MockUser6094/data/user.json': JSON.stringify({
      first_name: '测试用户',
      email: 'fake@example.com',
      is_active: true,
      date_joined: '2025-01-01T00:00:00.000Z',
    }),
    'MockUser6094/data/character.json': JSON.stringify({
      name: '星见雅',
      title: '深夜电台主播',
      created: '2025-02-01T00:00:00.000Z',
      updated: '2026-06-01T00:00:00.000Z',
    }),
    'MockUser6094/data/message.json': JSON.stringify([
      {
        id: 2,
        uuid: 'u2',
        candidate_id: 100,
        src: { id: 2, name: '星见雅', is_human: false, raw_content: '欢迎回来，今天想聊点什么？', text: 'WRONG-不应取此字段' },
        created: '2026-06-13T14:43:00.000Z',
        created_at: '2026-06-13T14:43:00.000Z',
      },
      {
        id: 3,
        uuid: 'u3',
        candidate_id: 101,
        src: { id: 1, name: '测试用户', is_human: true, raw_content: '想继续昨天的话题' },
        created_at: '2026-06-13T14:43:21.000Z',
      },
      {
        id: 4,
        uuid: 'u4',
        candidate_id: 102,
        src: { id: 2, name: '星见雅', is_human: false, raw_content: '好呀，昨天我们聊到星星那里了。' },
        created_at: '2026-06-13T14:43:29.000Z',
      },
      {
        id: 1,
        uuid: 'u1',
        candidate_id: 99,
        src: { id: 1, name: '测试用户', is_human: true, raw_content: '（乱序最早的一条）你好呀' },
        created_at: '2026-06-13T14:42:00.000Z',
      },
    ]),
  });
}

test('characterai：ZIP 三文件关联映射（raw_content 字段优先 / is_human 角色 / 乱序按时间稳定排序）', async () => {
  const r = await adaptCharacterAI(characteraiZipFixture());
  assert.equal(r.messages.length, 4);
  // 全量有时间戳 → 按时间排序（乱序的 id=1 排最前）
  assert.equal(r.messages[0].text, '（乱序最早的一条）你好呀');
  assert.deepEqual(
    r.messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant'],
  );
  // 消息文本取 raw_content（decoy text 字段被忽略）
  assert.ok(r.messages.every((m) => !m.text.includes('WRONG')));
  assert.equal(r.messages[1].text, '欢迎回来，今天想聊点什么？');
  // 时间戳
  assert.equal(r.messages[1].ts, Date.parse('2026-06-13T14:43:00.000Z'));
  // 来源摘要：三文件关联信息
  assert.equal(r.meta.characterName, '星见雅');
  assert.equal(r.meta.userName, '测试用户');
  assert.equal(r.meta.sortedByTime, true);
  assert.equal(r.messages[1].meta?.speaker, '星见雅');
});

test('characterai：files 映射输入（顶层字段形态 + is_human 缺失按说话人名推断 + 未知说话人待标注）', async () => {
  const r = await adaptCharacterAI({
    kind: 'files',
    files: {
      'user.json': JSON.stringify({ first_name: '阿零' }),
      'character.json': JSON.stringify({ name: '小满' }),
      'message.json': JSON.stringify([
        { raw_content: '顶层形态的消息', is_human: false, created_at: '2026-06-13T10:00:00.000Z' },
        { raw_content: '没有 is_human，但名字是用户', name: '阿零', created_at: '2026-06-13T10:00:01.000Z' },
        { raw_content: '没有 is_human，但名字是角色', name: '小满', created_at: '2026-06-13T10:00:02.000Z' },
        { raw_content: '完全无法判定说话方', name: '神秘人', created_at: '2026-06-13T10:00:03.000Z' },
      ]),
    },
  });
  assert.equal(r.messages.length, 4);
  assert.equal(r.messages[0].role, 'assistant'); // 顶层 is_human
  assert.equal(r.messages[1].role, 'user'); // 按用户名推断
  assert.equal(r.messages[2].role, 'assistant'); // 按角色名推断
  assert.equal(r.messages[3].role, 'unlabeled'); // 待标注
  assert.equal(r.messages[3].meta?.pendingLabel, true);
  assert.equal(r.stats.pendingLabel, 1);
});

test('characterai：ZIP 内缺 message.json 明确报错', async () => {
  const badZip = makeZip({ 'only/other.json': '{}' });
  await assert.rejects(() => adaptCharacterAI(badZip), /未找到 message\.json/);
});

test('characterai：端到端——ZIP→适配器→统一 schema→lite→记忆包三格式', async () => {
  const l0 = await adaptCharacterAI(characteraiZipFixture());
  const r = await runLitePipeline({ input: l0.messages, title: 'characterai 导入' });
  assert.equal(r.messages.length, 4);
  assert.deepEqual(
    r.messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant'],
  );
  assert.equal(r.messages[0].ts, Date.parse('2026-06-13T14:42:00.000Z'));
  const wakeupLines = r.mempack.wakeupMem.split('\n').filter((l) => l.length > 0);
  assert.equal(wakeupLines.length, 5, '首行 meta + 4 条消息');
  const msgLines = r.mempack.messages.split('\n').filter((l) => l.length > 0);
  assert.equal(msgLines.length, 4);
  assert.ok(r.mempack.markdown.includes('characterai 导入'));
  assert.ok(r.mempack.markdown.includes('（乱序最早的一条）你好呀'));
});

/* ================================================================
 * 四、SillyTavern jsonl
 * ===============================================================*/

function stChatlogFixture(): string {
  return [
    JSON.stringify({ user_name: '测试用户', character_name: '星见雅' }),
    JSON.stringify({ name: '测试用户', is_user: true, is_system: false, send_date: '1718291001000', mes: '你还好吗？', swipes: ['你还好吗？'], swipe_id: 0 }),
    JSON.stringify({ name: '星见雅', is_user: false, is_system: false, send_date: 1718291005000, mes: '我一直都在哦。' }),
    JSON.stringify({ name: '星见雅', is_user: false, is_system: false, send_date: 1718291009, mes: '（秒级时间戳的消息）嗯嗯。' }),
    JSON.stringify({ name: '星见雅', is_user: false, is_system: true, send_date: 'June 13, 2025 10:27:37pm', mes: '[场景切换] 雨夜的便利店' }),
    '这一行不是 JSON',
    JSON.stringify({ name: '星见雅', is_user: false, is_system: false, send_date: '无法解析的时间', mes: '没有时间的消息' }),
  ].join('\n');
}

test('st-chatlog：社区标准格式映射（角色 / mes 文本 / send_date 多形态 / 元数据首行 / 不可解析行跳过）', async () => {
  const r = await adaptStChatlog(stChatlogFixture());
  assert.equal(r.messages.length, 5);
  assert.deepEqual(
    r.messages.map((m) => m.role),
    ['user', 'assistant', 'assistant', 'system', 'assistant'],
  );
  // send_date：epoch 毫秒串
  assert.equal(r.messages[0].ts, 1718291001000);
  // epoch 毫秒数值
  assert.equal(r.messages[1].ts, 1718291005000);
  // epoch 秒数值 → ms
  assert.equal(r.messages[2].ts, 1718291009000);
  // 人性化日期（UTC 构造）
  assert.equal(r.messages[3].ts, Date.UTC(2025, 5, 13, 22, 27, 37));
  // 无法解析的时间 → null
  assert.equal(r.messages[4].ts, null);
  // 首行会话元数据入 meta，不入消息
  assert.equal(r.meta.user_name, '测试用户');
  assert.equal(r.meta.character_name, '星见雅');
  // 不可解析行跳过
  assert.equal(r.stats.skipped, 1);
  // speaker 存证
  assert.equal(r.messages[1].meta?.speaker, '星见雅');
});

test('st-chatlog：空输入与全无效输入明确报错', async () => {
  await assert.rejects(() => adaptStChatlog(''), /输入为空/);
  await assert.rejects(() => adaptStChatlog('随便一行\n另一行'), /未识别到任何消息行/);
});

test('st-chatlog：端到端——jsonl→适配器→统一 schema→lite→记忆包三格式', async () => {
  const l0 = await adaptStChatlog(stChatlogFixture());
  const r = await runLitePipeline({ input: l0.messages, title: 'st 导入' });
  assert.equal(r.messages.length, 5);
  assert.deepEqual(
    r.messages.map((m) => m.role),
    ['user', 'assistant', 'assistant', 'system', 'assistant'],
  );
  assert.equal(r.messages[0].ts, 1718291001000);
  const wakeupLines = r.mempack.wakeupMem.split('\n').filter((l) => l.length > 0);
  assert.equal(wakeupLines.length, 6, '首行 meta + 5 条消息');
  const msgLines = r.mempack.messages.split('\n').filter((l) => l.length > 0);
  assert.equal(msgLines.length, 5);
  assert.ok(r.mempack.markdown.includes('st 导入'));
  assert.ok(r.mempack.markdown.includes('你还好吗？'));
});

/* ================================================================
 * 五、统一 schema 形状合规（四适配器横向）
 * ===============================================================*/

test('L0 输出统一 schema 形状合规（role ∈ 四值 / text string / ts number|null / meta object）', async () => {
  const results: L0Result[] = [
    await adaptChatGPT(chatgptFixture()),
    await adaptClaude(claudeFixture()),
    await adaptCharacterAI(characteraiZipFixture()),
    await adaptStChatlog(stChatlogFixture()),
  ];
  for (const r of results) {
    for (const m of r.messages) {
      assert.ok(
        m.role === 'user' || m.role === 'assistant' || m.role === 'system' || m.role === 'unlabeled',
        `role 应为四值之一，实际 ${String(m.role)}`,
      );
      assert.equal(typeof m.text, 'string');
      assert.ok(m.ts === null || typeof m.ts === 'number');
      assert.equal(typeof m.meta, 'object');
    }
  }
});
