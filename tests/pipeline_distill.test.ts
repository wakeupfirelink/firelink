/**
 * 记忆引擎内核 36.1 · L3 提纯框架测试
 * ---------------------------------------------------------------
 * 覆盖验收点：
 * - 无 key 降级：provider 缺失 → skipped:true 不报错
 * - mock provider：周摘要/锚点/分层标签三路产出 + JSON 容错解析
 * - provider 切换：≥2 个 OpenAI 兼容端点可切换（mock ×2 + 注入 fetch 验证
 *   请求体/端点拼装，零真实网络）
 * - createProviderFromEnv：环境变量注入优先级与无 key 返回 undefined
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distill,
  distillWeek,
  distillLayers,
  createProviderFromEnv,
  OpenAICompatibleProvider,
  skippedDistill,
  groupByWeek,
  isoWeekKey,
  PROMPTS,
} from '../src/distill.js';
import type { UnifiedMessage } from '../src/structure.js';
import { MockLLMProvider } from './pipeline_test_helpers.js';

/** 构造两条周分布的消息集（2026-06-08 ~ 06-14 一周 / 06-15 ~ 06-21 一周） */
function twoWeekMessages(): UnifiedMessage[] {
  const msgs: UnifiedMessage[] = [];
  const base = Date.UTC(2026, 5, 8, 10, 0, 0);
  for (let i = 0; i < 8; i++) {
    msgs.push({
      ts: base + i * 3600_000,
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `第一周消息${i}`,
    });
  }
  const base2 = Date.UTC(2026, 5, 15, 10, 0, 0);
  for (let i = 0; i < 6; i++) {
    msgs.push({
      ts: base2 + i * 3600_000,
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `第二周消息${i}`,
    });
  }
  return msgs;
}

/* ================================================================
 * 一、无 key 降级
 * ===============================================================*/

test('L3：无 provider 自动跳过（skipped:true，不报错）', async () => {
  const r = await distill(twoWeekMessages(), {});
  assert.equal(r.skipped, true);
  assert.equal(r.skipReason, 'no_provider');
  assert.deepEqual(r.weeklySummaries, []);
  assert.deepEqual(r.anchors, []);
  assert.deepEqual(r.longTerm, []);
  assert.deepEqual(r.notebook, []);
  assert.deepEqual(r.profile, []);
  assert.equal(r.meta.llmCalls, 0);
  assert.equal(r.meta.provider, null);
});

test('L3：skippedDistill 工厂（时间戳注入）', () => {
  const r = skippedDistill(() => 1760000000000);
  assert.equal(r.meta.generatedAt, '2025-10-09T08:53:20.000Z');
});

/* ================================================================
 * 二、mock provider 三阶段产出
 * ===============================================================*/

test('L3：周摘要/锚点/分层标签三路产出（mock）', async () => {
  const mock = new MockLLMProvider();
  const r = await distill(twoWeekMessages(), { provider: mock });
  assert.equal(r.skipped, false);
  assert.equal(r.weeklySummaries.length, 2); // 两周两批
  assert.ok(r.weeklySummaries[0].summary.length > 0);
  assert.equal(r.weeklySummaries[0].messageCount, 8);
  assert.equal(r.anchors.length, 4); // 每周 2 锚点
  assert.equal(r.anchors[0].event, '情绪危机后互相安抚');
  // 三路分层
  assert.equal(r.longTerm.length, 1);
  assert.equal(r.longTerm[0].category, 'relationship');
  assert.equal(r.notebook.length, 1);
  assert.ok(r.notebook[0].text.length <= 50);
  assert.equal(r.profile.length, 1);
  assert.equal(r.profile[0].dimension, 'habits');
  // LLM 调用数：2 周 × 2 次 + 分层 1 次 = 5
  assert.equal(r.meta.llmCalls, 5);
  assert.equal(r.meta.provider, 'mock-llm');
});

test('L3：LLM 返回围栏 JSON 也能容错解析', async () => {
  const mock = new MockLLMProvider('mock-fenced', 'm', (req) => {
    if (req.user.includes('"summary"')) return '```json\n{"summary":"围栏摘要"}\n```';
    if (req.user.includes('"anchors"')) return '前缀噪声 {"anchors":[{"date":"2026-06-13","ts":null,"event":"事件","importance":3}]} 后缀噪声';
    return '好的，如下：{"longTerm":[],"notebook":[],"profile":[]} 完毕';
  });
  const r = await distill(twoWeekMessages().slice(0, 4), { provider: mock });
  assert.equal(r.weeklySummaries[0].summary, '围栏摘要');
  assert.equal(r.anchors[0].event, '事件');
  assert.deepEqual(r.longTerm, []);
});

test('L3：LLM 返回完全不可解析 → 空结果不抛错（批级降级）', async () => {
  const mock = new MockLLMProvider('mock-garbage', 'm', () => '我拒绝输出 JSON');
  const r = await distill(twoWeekMessages().slice(0, 4), { provider: mock });
  assert.equal(r.skipped, false);
  assert.equal(r.weeklySummaries[0].summary, ''); // 摘要空串
  assert.deepEqual(r.anchors, []);
  assert.deepEqual(r.longTerm, []);
});

test('L3：形状校验过滤畸形条目（anchored 层防脏数据穿透）', async () => {
  const mock = new MockLLMProvider('mock-dirty', 'm', (req) => {
    if (req.user.includes('"anchors"')) {
      return JSON.stringify({
        anchors: [
          { date: '2026-06-13', event: '合法锚点', importance: 2 }, // ts 缺省 → null
          { date: 123, event: '畸形日期' }, // date 非字符串 → 过滤
          '不是对象',
        ],
      });
    }
    if (req.user.includes('"longTerm"')) {
      return JSON.stringify({
        longTerm: [
          { text: '合法长期记忆' },
          { text: '非法分类', category: 'nope' }, // 非法 category → 过滤
        ],
        notebook: [{ text: '合法笔记' }, { score: '非数字' }],
        profile: [{ dimension: 'preferences', key: '口味', value: '甜' }, { dimension: '非法', key: 'x', value: 'y' }],
      });
    }
    return JSON.stringify({ summary: 's' });
  });
  const r = await distill(twoWeekMessages().slice(0, 4), { provider: mock });
  assert.equal(r.anchors.length, 1);
  assert.equal(r.anchors[0].ts, null);
  assert.equal(r.longTerm.length, 1);
  assert.equal(r.notebook.length, 1);
  assert.equal(r.profile.length, 1);
});

/* ================================================================
 * 三、provider 切换（≥2 个 OpenAI 兼容端点）
 * ===============================================================*/

test('L3：provider 切换——两个 mock 端点（meta.provider 跟随切换）', async () => {
  const a = new MockLLMProvider('endpoint-a', 'model-a');
  const b = new MockLLMProvider('endpoint-b', 'model-b');
  const messages = twoWeekMessages().slice(0, 4);
  const ra = await distill(messages, { provider: a });
  const rb = await distill(messages, { provider: b });
  assert.equal(ra.meta.provider, 'endpoint-a');
  assert.equal(ra.meta.model, 'model-a');
  assert.equal(rb.meta.provider, 'endpoint-b');
  assert.equal(rb.meta.model, 'model-b');
  // 两个端点各自被调用（BYO key 语义：谁注入谁干活）
  assert.ok(a.calls.length > 0);
  assert.ok(b.calls.length > 0);
});

test('L3：OpenAICompatibleProvider 请求格式与端点拼装（注入 fetch，零网络）', async () => {
  const seen: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      body: JSON.parse(String(init!.body)) as Record<string, unknown>,
      auth: String((init!.headers as Record<string, string>)['authorization']),
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"summary":"ok"}' } }] }),
    } as Response;
  }) as typeof fetch;

  // 端点一：DeepSeek 形
  const deepseek = new OpenAICompatibleProvider({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-test-1',
    model: 'deepseek-chat',
    fetchImpl: fakeFetch,
  });
  // 端点二：自定义 OpenAI 兼容端点
  const custom = new OpenAICompatibleProvider({
    baseUrl: 'https://llm.example.com/v1/',
    apiKey: 'sk-test-2',
    model: 'my-model',
    fetchImpl: fakeFetch,
  });

  const r1 = await deepseek.chat({ user: 'hi', json: true });
  assert.equal(r1, '{"summary":"ok"}');
  assert.equal(seen[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(seen[0].auth, 'Bearer sk-test-1');
  assert.equal((seen[0].body as { model: string }).model, 'deepseek-chat');
  assert.deepEqual((seen[0].body as { response_format?: unknown }).response_format, { type: 'json_object' });

  const r2 = await custom.chat({ system: 's', user: 'hi' });
  assert.ok(r2.length > 0);
  assert.equal(seen[1].url, 'https://llm.example.com/v1/chat/completions'); // 尾斜杠归一
  assert.equal(seen[1].auth, 'Bearer sk-test-2');
  assert.equal((seen[1].body as { model: string }).model, 'my-model');
  assert.equal((seen[1].body as { messages: unknown[] }).messages.length, 2); // system+user

  // provider.name = 端点域名（切换可辨识）
  assert.equal(deepseek.name, 'api.deepseek.com');
  assert.equal(custom.name, 'llm.example.com');
});

/* ================================================================
 * 四、createProviderFromEnv（key 环境变量注入）
 * ===============================================================*/

test('L3：createProviderFromEnv 优先级与降级', () => {
  // 无任何 key → undefined
  assert.equal(createProviderFromEnv({}), undefined);
  assert.equal(createProviderFromEnv({ SOMETHING_ELSE: 'x' }), undefined);

  // DEEPSEEK_API_KEY → DeepSeek 默认端点
  const ds = createProviderFromEnv({ DEEPSEEK_API_KEY: 'sk-ds' })!;
  assert.equal(ds.name, 'api.deepseek.com');
  assert.equal(ds.model, 'deepseek-chat');

  // MEMORY_LLM_* 通用注入优先（自定义端点+模型）
  const custom = createProviderFromEnv({
    MEMORY_LLM_API_KEY: 'sk-custom',
    MEMORY_LLM_BASE_URL: 'https://my-endpoint.com',
    MEMORY_LLM_MODEL: 'my-model',
    DEEPSEEK_API_KEY: 'sk-ds', // 应被通用注入覆盖
  })!;
  assert.equal(custom.name, 'my-endpoint.com');
  assert.equal(custom.model, 'my-model');

  // OPENAI_API_KEY → OpenAI 默认（含 base url 覆盖）
  const oa = createProviderFromEnv({
    OPENAI_API_KEY: 'sk-oa',
    OPENAI_BASE_URL: 'https://relay.example.com/v1',
  })!;
  assert.equal(oa.name, 'relay.example.com');
});

/* ================================================================
 * 五、周分批工具
 * ===============================================================*/

test('L3：groupByWeek 按自然周分组（unknown 批殿后）', () => {
  const weeks = groupByWeek(twoWeekMessages());
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].weekKey, '2026-W24');
  assert.equal(weeks[0].messages.length, 8);
  assert.equal(weeks[1].weekKey, '2026-W25');
  // null ts → unknown 批
  const withNull: UnifiedMessage[] = [...twoWeekMessages(), { ts: null, role: 'user' as const, text: '无时间' }];
  const weeks2 = groupByWeek(withNull);
  assert.equal(weeks2.length, 3);
  assert.equal(weeks2[2].weekKey, 'unknown');
});

test('L3：isoWeekKey 边界（跨年周）', () => {
  assert.equal(isoWeekKey(new Date(Date.UTC(2026, 0, 1))), '2026-W01');
  assert.equal(isoWeekKey(new Date(Date.UTC(2026, 11, 31))), '2026-W53');
});

test('L3：distillWeek/distillLayers 单周入口（断点续跑编排件）', async () => {
  const mock = new MockLLMProvider();
  const weeks = groupByWeek(twoWeekMessages());
  const r = await distillWeek(weeks[0], mock, {});
  assert.equal(r.summary.messageCount, 8);
  assert.equal(r.anchors.length, 2);
  assert.equal(r.llmCalls, 2);

  const layers = await distillLayers(r.summary ? [r.summary] : [], r.anchors, mock);
  assert.equal(layers.longTerm.length, 1);
});

test('L3：提示词模板全部内置且含输出契约', () => {
  assert.ok(PROMPTS.weeklySummary.system.includes('JSON'));
  assert.ok(PROMPTS.weeklySummary.user({ weekKey: 'W', start: 'a', end: 'b', transcript: 't' }).includes('"summary"'));
  assert.ok(PROMPTS.anchorExtraction.user({ weekKey: 'W', transcript: 't' }).includes('"anchors"'));
  assert.ok(PROMPTS.layerTagging.user({ summaries: 's', anchors: 'a' }).includes('"longTerm"'));
  assert.ok(PROMPTS.layerTagging.user({ summaries: 's', anchors: 'a' }).includes('"notebook"'));
  assert.ok(PROMPTS.layerTagging.user({ summaries: 's', anchors: 'a' }).includes('"profile"'));
});
