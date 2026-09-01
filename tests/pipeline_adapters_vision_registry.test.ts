/**
 * 记忆引擎内核 36.2 · L0 适配器测试 · 视觉 / 接入位 / 注册表 / 嗅探 / 总装
 * ---------------------------------------------------------------
 * - screenshot：多模态 provider 可插拔（MockVisionProvider）、无 provider 明确
 *   报错、不可解析输出降级待标注、OpenAIVisionProvider 请求形状（fetch mock）
 * - qq-export：接入位 throw NotImplemented（adapterName 可识别）
 * - registry：8 适配器注册齐 / 状态标注 / convertWithAdapter 分派
 * - sniffL0Source：来源类型自动嗅探（JSON 特征 / ZIP 清单 / 图片魔数 /
 *   路径扩展名 / files 映射 / 消息头模式 low）
 * - runLiteFromSource：嗅探→适配器→统一 schema→lite 全链→记忆包三格式
 * 施工纪律：LLM 单测一律 mock（视觉走 MockVisionProvider / fetch 注入），
 * 禁止调真实 API；敏感字段一律假数据（假密钥 / 假用户）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

import {
  adaptScreenshot,
  OpenAIVisionProvider,
  PROMPT_SCREENSHOT_TRANSCRIBE,
  sniffImageMime,
} from '../src/adapters/screenshot.js';
import { qqExportAdapter, NotImplementedError } from '../src/adapters/qq-export.js';
import {
  L0_ADAPTERS,
  getL0Adapter,
  listL0Adapters,
  convertWithAdapter,
  sniffL0Source,
  runLiteFromSource,
} from '../src/adapters/registry.js';
import { runLitePipeline } from '../src/lite.js';
import { MockLLMProvider, makeTestDir, cleanupTestDir } from './pipeline_test_helpers.js';
import {
  makeZip,
  makeDocx,
  MockVisionProvider,
  fakePngBytes,
  fakeJpegBytes,
} from './pipeline_adapters_helpers.js';

/* ================================================================
 * 共享 fixture（与 sources 测试同构，敏感字段一律假数据）
 * ===============================================================*/

/** ChatGPT 官方 conversations.json 形（mapping 消息树，5 条有效消息） */
function chatgptJson(): string {
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
          children: ['n-b'],
        },
        'n-b': {
          id: 'n-b',
          message: { id: 'm2', author: { role: 'assistant' }, create_time: 1718275230, content: { content_type: 'text', parts: ['当然记得，那天你问了我关于时间线的问题。'] } },
          parent: 'n-a',
          children: ['n-c'],
        },
        'n-c': {
          id: 'n-c',
          message: { id: 'm3', author: { role: 'user' }, create_time: 1718275250, content: { content_type: 'text', parts: ['那把这些记忆保存下来吧'] } },
          parent: 'n-b',
          children: ['n-d'],
        },
        'n-d': {
          id: 'n-d',
          message: { id: 'm4', author: { role: 'assistant' }, create_time: 1718275260, content: { content_type: 'text', parts: ['好的，我会一直记得。'] } },
          parent: 'n-c',
          children: [],
        },
      },
    },
  ]);
}

/** Claude 官方 conversations.json 形（chat_messages，3 条有效消息） */
function claudeJson(): string {
  return JSON.stringify([
    {
      uuid: 'conv-1',
      name: '日常对话',
      created_at: '2026-06-13T14:43:00.000Z',
      chat_messages: [
        { uuid: 'cm-1', sender: 'human', text: '今天过得怎么样？', created_at: '2026-06-13T14:43:21.000Z' },
        { uuid: 'cm-2', sender: 'assistant', text: '很好哦，一直在等你回来。', created_at: '2026-06-13T14:43:29.000Z' },
        { uuid: 'cm-3', sender: 'assistant', text: '早上好', created_at: '2026-06-14T01:02:03.000Z' },
      ],
    },
  ]);
}

/** SillyTavern jsonl（两行消息，无首行元数据） */
function stJsonl(): string {
  return [
    JSON.stringify({ name: '测试用户', is_user: true, is_system: false, send_date: '1718291001000', mes: '你还好吗？' }),
    JSON.stringify({ name: '星见雅', is_user: false, is_system: false, send_date: 1718291005000, mes: '我一直都在哦。' }),
  ].join('\n');
}

/** Character.AI 导出 ZIP（三件套最小形） */
function characteraiZip(): Uint8Array {
  return makeZip({
    'MockUser6094/data/user.json': JSON.stringify({ first_name: '测试用户' }),
    'MockUser6094/data/character.json': JSON.stringify({ name: '星见雅' }),
    'MockUser6094/data/message.json': JSON.stringify([
      { src: { raw_content: '你好呀', is_human: true }, created_at: '2026-06-13T14:43:21.000Z' },
      { src: { raw_content: '欢迎回来', is_human: false }, created_at: '2026-06-13T14:43:29.000Z' },
    ]),
  });
}

/* ================================================================
 * 一、screenshot：多模态转写
 * ===============================================================*/

test('screenshot：未提供 multimodal provider 明确报错（截图无 LLM 无兜底路径）', async () => {
  await assert.rejects(
    () => adaptScreenshot(fakePngBytes()),
    /多模态 LLM provider/,
  );
});

test('screenshot：mock provider JSON 转写（角色归一 / 无时间戳 / llmAssisted 统计 / prompt 与 mime 透传）', async () => {
  const provider = new MockVisionProvider(() =>
    JSON.stringify([
      { role: 'user', text: '今天外面下雨了吗？' },
      { role: 'assistant', text: '查了一下，小雨，记得带伞。' },
      { role: '看不清是谁', text: '这条的说话方无法判断' },
    ]),
  );
  const r = await adaptScreenshot(fakePngBytes('shot-a'), { multimodal: provider });
  assert.equal(r.messages.length, 3);
  // 未知角色 → unlabeled
  assert.deepEqual(
    r.messages.map((m) => m.role),
    ['user', 'assistant', 'unlabeled'],
  );
  // 截图没有可靠时间戳
  assert.ok(r.messages.every((m) => m.ts === null));
  // 统计与存证
  assert.equal(r.stats.llmAssisted, 3);
  assert.equal(r.stats.pendingLabel, 0);
  assert.equal(r.meta.parseMode, 'json');
  assert.equal(r.meta.mimeType, 'image/png');
  // provider 收到的请求：内置转写提示词 + 魔数嗅探 mime + 原始字节
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].prompt, PROMPT_SCREENSHOT_TRANSCRIBE);
  assert.equal(provider.calls[0].mimeType, 'image/png');
  assert.ok(
    Buffer.from(provider.calls[0].image).equals(Buffer.from(fakePngBytes('shot-a'))),
    'provider 应收到原始图片字节',
  );
});

test('screenshot：代码围栏包裹的 JSON 也能解析', async () => {
  const provider = new MockVisionProvider(
    () => '```json\n[{"role":"user","text":"围栏里的消息"}]\n```',
  );
  const r = await adaptScreenshot(fakePngBytes('shot-b'), { multimodal: provider });
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].role, 'user');
  assert.equal(r.messages[0].text, '围栏里的消息');
});

test('screenshot：LLM 输出不可解析 → 降级单条待标注消息（不报错）', async () => {
  const provider = new MockVisionProvider(() => '这张截图里好像没有可转写的对话内容。');
  const r = await adaptScreenshot(fakePngBytes('shot-c'), { multimodal: provider });
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].role, 'unlabeled');
  assert.equal(r.messages[0].text, '这张截图里好像没有可转写的对话内容。');
  assert.equal(r.messages[0].meta?.pendingLabel, true);
  assert.equal(r.stats.pendingLabel, 1);
  assert.equal(r.meta.parseMode, 'fallback');
});

test('screenshot：本地路径输入（魔数嗅探 mime，非扩展名）', async () => {
  const dir = makeTestDir('screenshot_path');
  try {
    const pngPath = join(dir, 'shot.png');
    await writeFile(pngPath, fakePngBytes('from-path'));
    const provider = new MockVisionProvider(() =>
      JSON.stringify([{ role: 'user', text: '路径输入的截图转写' }]),
    );
    const r = await adaptScreenshot({ kind: 'path', path: pngPath }, { multimodal: provider });
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0].role, 'user');
    assert.equal(provider.calls[0].mimeType, 'image/png');
  } finally {
    cleanupTestDir('screenshot_path');
  }
});

test('screenshot：图片魔数嗅探（PNG / JPEG / GIF / WEBP / 未知）', () => {
  assert.equal(sniffImageMime(fakePngBytes()), 'image/png');
  assert.equal(sniffImageMime(fakeJpegBytes()), 'image/jpeg');
  assert.equal(
    sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])),
    'image/gif',
  );
  assert.equal(
    sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    'image/webp',
  );
  assert.equal(sniffImageMime(new TextEncoder().encode('not an image')), null);
});

test('screenshot：OpenAIVisionProvider 请求形状（OpenAI 兼容 /chat/completions 协议，fetch 注入 mock）', async () => {
  interface Captured {
    url: string;
    authorization: string;
    contentType: string;
    body: {
      model: string;
      temperature: number;
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
  }
  const captured: Captured[] = [];
  const provider = new OpenAIVisionProvider({
    baseUrl: 'https://api.example.com/',
    apiKey: 'sk-fake-vision-key-000',
    model: 'fake-vision-model',
    temperature: 0.2,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      captured.push({
        url: String(url),
        authorization: headers.get('authorization') ?? '',
        contentType: headers.get('content-type') ?? '',
        body: JSON.parse(String(init?.body)) as Captured['body'],
      });
      return {
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  const out = await provider.transcribe({
    image: fakePngBytes('vision-shape'),
    mimeType: 'image/png',
    prompt: '转写这张图',
  });
  assert.equal(out, 'ok');

  assert.equal(captured.length, 1);
  const req = captured[0];
  // 端点拼接（baseUrl 尾斜杠归一）
  assert.equal(req.url, 'https://api.example.com/chat/completions');
  // 认证头与内容类型
  assert.equal(req.authorization, 'Bearer sk-fake-vision-key-000');
  assert.equal(req.contentType, 'application/json');
  // 请求体：模型 / 采样参数
  assert.equal(req.body.model, 'fake-vision-model');
  assert.equal(req.body.temperature, 0.2);
  // 多模态 content 协议：text 段 + data URI 图片段
  assert.equal(req.body.messages.length, 1);
  const msg = req.body.messages[0];
  assert.equal(msg.role, 'user');
  assert.equal(msg.content.length, 2);
  assert.equal(msg.content[0].type, 'text');
  assert.equal(msg.content[0].text, '转写这张图');
  assert.equal(msg.content[1].type, 'image_url');
  const dataUri = (msg.content[1].image_url as { url: string }).url;
  assert.ok(dataUri.startsWith('data:image/png;base64,'), 'data URI 前缀');
  assert.ok(
    Buffer.from(dataUri.slice('data:image/png;base64,'.length), 'base64').equals(
      Buffer.from(fakePngBytes('vision-shape')),
    ),
    'data URI 应为原始图片字节（含 PNG 魔数）的 base64',
  );
});

test('screenshot：端到端——截图→转写→统一 schema→lite→记忆包三格式', async () => {
  const provider = new MockVisionProvider(() =>
    JSON.stringify([
      { role: 'user', text: '今天外面下雨了吗？' },
      { role: 'assistant', text: '查了一下，小雨，记得带伞。' },
    ]),
  );
  const l0 = await adaptScreenshot(fakePngBytes('shot-e2e'), { multimodal: provider });
  const r = await runLitePipeline({ input: l0.messages, title: '截图导入' });
  assert.equal(r.messages.length, 2);
  assert.deepEqual(
    r.messages.map((m) => m.role),
    ['user', 'assistant'],
  );
  assert.ok(r.messages.every((m) => m.ts === null), '截图消息无时间戳，经 lite 保持 null');
  const wakeupLines = r.mempack.wakeupMem.split('\n').filter((l) => l.length > 0);
  assert.equal(wakeupLines.length, 3, '首行 meta + 2 条消息');
  assert.equal(JSON.parse(wakeupLines[0]).type, 'mempack-meta');
  const msgLines = r.mempack.messages.split('\n').filter((l) => l.length > 0);
  assert.equal(msgLines.length, 2);
  assert.equal(JSON.parse(msgLines[0]).role, 'user');
  assert.ok(r.mempack.markdown.includes('# 截图导入'));
  assert.ok(r.mempack.markdown.includes('记得带伞'));
});

/* ================================================================
 * 二、qq-export：闭源平台接入位
 * ===============================================================*/

test('qq-export：接入位 convert 一律 throw NotImplementedError（注册名可识别）', async () => {
  await assert.rejects(
    () => qqExportAdapter.convert('任意闭源平台导出内容'),
    (err: unknown) => {
      assert.ok(err instanceof NotImplementedError, '应为 NotImplementedError 实例');
      assert.equal((err as NotImplementedError).adapterName, 'qq-export');
      assert.equal((err as NotImplementedError).name, 'NotImplementedError');
      assert.match(err.message, /未实现/);
      return true;
    },
  );
});

/* ================================================================
 * 三、registry：统一注册表
 * ===============================================================*/

test('registry：8 个适配器全部注册（名字清单 / 键名一致 / 元数据完整）', () => {
  const names = Object.keys(L0_ADAPTERS).sort();
  assert.deepEqual(names, [
    'characterai',
    'chatgpt',
    'claude',
    'local-web',
    'qq-export',
    'screenshot',
    'st-chatlog',
    'txt-docx',
  ]);
  for (const [key, adapter] of Object.entries(L0_ADAPTERS)) {
    assert.equal(adapter.name, key, '注册键与适配器名一致');
    assert.ok(adapter.label.length > 0, `${key} 应有 label`);
    assert.ok(adapter.description.length > 0, `${key} 应有 description`);
    assert.equal(typeof adapter.convert, 'function', `${key} 应有 convert`);
  }
  // 名字唯一（注册表键天然去重；清单长度一致即无别名重复注册）
  assert.equal(listL0Adapters().length, 8);
  assert.equal(new Set(listL0Adapters().map((i) => i.name)).size, 8);
});

test('registry：接入位状态标注（qq-export not-implemented，其余 ready）', () => {
  const info = listL0Adapters();
  const qq = info.find((i) => i.name === 'qq-export');
  assert.equal(qq?.status, 'not-implemented');
  const ready = info.filter((i) => i.name !== 'qq-export');
  assert.equal(ready.length, 7);
  assert.ok(ready.every((i) => i.status === 'ready'));
});

test('registry：getL0Adapter 查询 / convertWithAdapter 分派（未注册报错 / 传实例 / 接入位冒泡）', async () => {
  assert.equal(getL0Adapter('no-such-adapter'), undefined);
  assert.ok(getL0Adapter('chatgpt') !== undefined);

  await assert.rejects(
    () => convertWithAdapter('no-such-adapter', 'x'),
    /未注册的适配器：no-such-adapter/,
  );
  // 接入位经统一入口调用同样 throw NotImplemented
  await assert.rejects(() => convertWithAdapter('qq-export', 'x'), NotImplementedError);
  // 按名与按实例等价
  const byName = await convertWithAdapter('claude', claudeJson());
  const claude = getL0Adapter('claude');
  assert.ok(claude !== undefined);
  const byInstance = await convertWithAdapter(claude, claudeJson());
  assert.equal(byName.messages.length, 3);
  assert.equal(byInstance.messages.length, 3);
});

/* ================================================================
 * 四、sniffL0Source：来源类型自动嗅探
 * ===============================================================*/

test('sniff：结构化 JSON 特征（chatgpt mapping / claude chat_messages / characterai raw_content）', async () => {
  // 文本输入：整体 JSON 解析
  const chatgpt = await sniffL0Source(chatgptJson());
  assert.deepEqual(
    chatgpt && { name: chatgpt.name, confidence: chatgpt.confidence },
    { name: 'chatgpt', confidence: 'high' },
  );
  const claude = await sniffL0Source(claudeJson());
  assert.deepEqual(
    claude && { name: claude.name, confidence: claude.confidence },
    { name: 'claude', confidence: 'high' },
  );
  // 已解析对象输入：单会话对象含 mapping
  const chatgptObj = await sniffL0Source(
    JSON.parse(chatgptJson())[0] as unknown as Record<string, unknown>,
  );
  assert.equal(chatgptObj?.name, 'chatgpt');
  // 已解析对象输入：conversations 键包装
  const wrapped = await sniffL0Source({ conversations: JSON.parse(claudeJson()) });
  assert.equal(wrapped?.name, 'claude');
  // 已解析数组输入：消息对象含 raw_content → characterai
  const caiParsed = await sniffL0Source({
    messages: [{ src: { raw_content: '你好', is_human: true } }],
  });
  assert.equal(caiParsed, null, '无 message 数组键时不应误判（嗅探仅认 conversations 键）');
  const caiConversations = await sniffL0Source({
    conversations: [{ src: { raw_content: '你好', is_human: true } }],
  });
  assert.equal(caiConversations?.name, 'characterai');
});

test('sniff：二进制特征（docx / characterai ZIP 三件套 / 图片魔数）', async () => {
  const docx = await sniffL0Source(makeDocx(['星见雅: 06-13 22:43:21 你好']));
  assert.equal(docx?.name, 'txt-docx');
  assert.equal(docx?.confidence, 'high');

  const cai = await sniffL0Source(characteraiZip());
  assert.equal(cai?.name, 'characterai');
  assert.equal(cai?.confidence, 'high');

  // 只有 message.json 无 character.json 的 ZIP → 无法判定（不强判）
  const partialZip = await sniffL0Source(
    makeZip({ 'x/data/message.json': '[]', 'word/document.xml': '<w/>' }),
  );
  assert.equal(partialZip?.name, 'txt-docx', 'docx 特征优先（document.xml 命中）');

  const png = await sniffL0Source(fakePngBytes());
  assert.equal(png?.name, 'screenshot');
  const jpeg = await sniffL0Source(fakeJpegBytes());
  assert.equal(jpeg?.name, 'screenshot');

  // 非图片非 ZIP 的字节 → null
  assert.equal(await sniffL0Source(new TextEncoder().encode('plain text bytes')), null);
});

test('sniff：文本特征（HTML / jsonl / 消息头 low / 乱文本与空输入 null）', async () => {
  const html = await sniffL0Source(
    '<!DOCTYPE html><html><body><p>星见雅: 06-13 22:43:21 你好</p></body></html>',
  );
  assert.equal(html?.name, 'local-web');
  assert.equal(html?.confidence, 'high');

  const st = await sniffL0Source(stJsonl());
  assert.equal(st?.name, 'st-chatlog');
  assert.equal(st?.confidence, 'high');

  // 段头模式文本（无年份日期）→ txt-docx 低置信
  const headers = await sniffL0Source(
    '星见雅: 06-13 22:43:21 我在呢\n星见雅: 06-13 22:43:40 在的',
  );
  assert.deepEqual(
    headers && { name: headers.name, confidence: headers.confidence },
    { name: 'txt-docx', confidence: 'low' },
  );

  // 无法判定
  assert.equal(await sniffL0Source('今天天气不错，出去走走吧，路上看到一只猫。'), null);
  assert.equal(await sniffL0Source(''), null);
});

test('sniff：本地路径输入（扩展名分派 + 内容兜底）', async () => {
  const dir = makeTestDir('adapters_sniff');
  try {
    const cases: Array<{ file: string; data: string | Uint8Array; expect: string }> = [
      { file: 'conv.docx', data: makeDocx(['星见雅: 06-13 22:43:21 你好']), expect: 'txt-docx' },
      { file: 'chat.zip', data: characteraiZip(), expect: 'characterai' },
      { file: 'shot.png', data: fakePngBytes(), expect: 'screenshot' },
      { file: 'log.jsonl', data: stJsonl(), expect: 'st-chatlog' },
      { file: 'page.html', data: '<html><body><p>正文</p></body></html>', expect: 'local-web' },
      { file: 'conv.txt', data: chatgptJson(), expect: 'chatgpt' },
    ];
    for (const c of cases) {
      const path = join(dir, c.file);
      await writeFile(path, c.data);
      const sniffed = await sniffL0Source({ kind: 'path', path });
      assert.equal(
        sniffed?.name ?? '(null)',
        c.expect,
        `${c.file} 应嗅探为 ${c.expect}，实际 ${String(sniffed?.name)}`,
      );
    }
    // 不存在的路径 → null（不抛错）
    assert.equal(await sniffL0Source({ kind: 'path', path: join(dir, 'missing.xyz') }), null);
  } finally {
    cleanupTestDir('adapters_sniff');
  }
});

test('sniff：files 多文件映射输入（三件套特征 → characterai）', async () => {
  const sniffed = await sniffL0Source({
    kind: 'files',
    files: {
      'user.json': JSON.stringify({ first_name: '测试用户' }),
      'character.json': JSON.stringify({ name: '星见雅' }),
      'message.json': JSON.stringify([{ src: { raw_content: '你好' } }]),
    },
  });
  assert.equal(sniffed?.name, 'characterai');
  assert.equal(sniffed?.confidence, 'high');
  // 无三件套特征的 files → null
  const other = await sniffL0Source({ kind: 'files', files: { 'a.txt': 'hello' } });
  assert.equal(other, null);
});

/* ================================================================
 * 五、runLiteFromSource：嗅探→适配器→lite 全链总装
 * ===============================================================*/

test('runLiteFromSource：自动嗅探 chatgpt→全链→记忆包三格式（adapter 信息存证）', async () => {
  const r = await runLiteFromSource({ input: chatgptJson(), lite: { title: '嗅探导入' } });
  assert.deepEqual(r.adapter, { name: 'chatgpt', sniffed: true, confidence: 'high' });
  // L0 原始输出可追溯（fixture 4 条有效消息：user/assistant/user/assistant）
  assert.equal(r.l0.messages.length, 4);
  assert.equal(r.l0.stats.skipped, 1, '空 system 节点跳过');
  // lite 全链保持消息数 / 角色 / 时间戳
  assert.equal(r.messages.length, 4);
  assert.deepEqual(
    r.messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant'],
  );
  assert.equal(r.messages[0].ts, 1718275200000);
  // 记忆包三格式
  const wakeupLines = r.mempack.wakeupMem.split('\n').filter((l) => l.length > 0);
  assert.equal(wakeupLines.length, 5, '首行 meta + 4 条消息');
  assert.equal(JSON.parse(wakeupLines[0]).type, 'mempack-meta');
  const msgLines = r.mempack.messages.split('\n').filter((l) => l.length > 0);
  assert.equal(msgLines.length, 4);
  assert.ok(r.mempack.markdown.includes('# 嗅探导入'));
  assert.ok(r.mempack.markdown.includes('你还记得我们第一次聊天的内容吗？'));
});

test('runLiteFromSource：显式指定 adapter（跳过嗅探，sniffed=false）', async () => {
  const r = await runLiteFromSource({ input: claudeJson(), adapter: 'claude', lite: { title: '显式' } });
  assert.equal(r.adapter.name, 'claude');
  assert.equal(r.adapter.sniffed, false);
  assert.equal(r.adapter.confidence, undefined);
  assert.equal(r.messages.length, 3);
});

test('runLiteFromSource：无法识别来源且未指定 adapter → 明确报错引导', async () => {
  await assert.rejects(
    () => runLiteFromSource({ input: '今天天气不错，出去走走吧。' }),
    /无法识别来源类型/,
  );
});

test('runLiteFromSource：qq-export 接入位 NotImplemented 冒泡', async () => {
  await assert.rejects(
    () => runLiteFromSource({ input: '任意内容', adapter: 'qq-export' }),
    NotImplementedError,
  );
});

test('runLiteFromSource：provider 同时分发适配器与 lite（L2 分角色 + L3 提纯同源）', async () => {
  const provider = new MockLLMProvider('mock-llm', 'mock-model', (req) => {
    if (req.user.includes('"role"')) {
      return JSON.stringify([
        { role: 'user', text: '今晚想吃点什么？上次你说想吃火锅。' },
        { role: 'assistant', text: '好呀，那就去吃火锅吧，我记得那家店的番茄锅底你很喜欢。' },
      ]);
    }
    if (req.user.includes('"summary"')) return JSON.stringify({ summary: '两人约好去吃火锅。' });
    if (req.user.includes('"anchors"')) return JSON.stringify({ anchors: [] });
    if (req.user.includes('"longTerm"')) {
      return JSON.stringify({ longTerm: [], notebook: [], profile: [] });
    }
    if (req.user.includes('"hits"')) return JSON.stringify({ hits: [] });
    return JSON.stringify({});
  });
  const r = await runLiteFromSource({
    input: '今晚想吃点什么\n那就去吃火锅吧',
    adapter: 'txt-docx',
    adapterOptions: { mode: 'plaintext' },
    provider,
    lite: { title: 'provider 透传' },
  });
  // 适配器侧：同一 provider 完成 LLM 分角色
  assert.equal(r.adapter.name, 'txt-docx');
  assert.equal(r.l0.stats.llmAssisted, 2);
  assert.deepEqual(
    r.messages.map((m) => m.role),
    ['user', 'assistant'],
  );
  // lite 侧：同一 provider 被 L3 提纯复用（调用数大于适配器的一次转写）
  assert.ok(
    provider.calls.length >= 2,
    `provider 应同时供适配器与 lite 使用，期望 >=2 次调用，实际 ${provider.calls.length}`,
  );
  // 三格式产出
  assert.equal(r.messages.length, 2);
  assert.ok(r.mempack.markdown.includes('# provider 透传'));
});
