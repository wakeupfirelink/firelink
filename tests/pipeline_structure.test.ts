/**
 * 记忆引擎内核 36.1 · L2 结构化层测试
 * ---------------------------------------------------------------
 * 覆盖验收点：
 * - 统一 schema {ts, role, text, meta}
 * - 结构化源直映射（RawMessage[]，含 ref 复原路径）
 * - 段头确定性解析（说话人 + MM-DD HH:MM:SS → ts；roleAliases 最长命中）
 * - 纯文本 LLM 分角色（mock provider）
 * - 无 key 降级：纯文本保留原文待标（unlabeled + pendingLabel），不报错
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  structureMessages,
  parseHeader,
  type RawMessage,
} from '../src/structure.js';
import { cleanSegments, DEFAULT_CLEAN_CONFIG, type Segment } from '../src/clean.js';
import { MockLLMProvider, loadHostSample, makeSyntheticChat, FAKE_SENSITIVE } from './pipeline_test_helpers.js';

const ALIASES = { 星见雅: 'assistant', 测试用户: 'user', 星见: 'assistant' } as const;
const BASE_YEAR = 2026;

/* ================================================================
 * 一、结构化源直映射
 * ===============================================================*/

test('L2：结构化源直映射（RawMessage[] → 统一 schema）', async () => {
  const input: RawMessage[] = [
    { role: 'user', text: '你好', ts: 1760000000000, meta: { turn: 1 } },
    { role: 'assistant', text: '我在呢', ts: '2026-06-13T22:43:29.000Z' },
    { text: '缺角色的消息' }, // role 缺省
    { role: 'weird_role', text: '非标准角色' }, // 非标准角色存证
  ];
  const r = await structureMessages(input, {});
  assert.equal(r.messages.length, 4);
  assert.equal(r.messages[0].role, 'user');
  assert.equal(r.messages[0].ts, 1760000000000);
  assert.deepEqual(r.messages[0].meta, { turn: 1, source: 'structured' });
  assert.equal(r.messages[1].ts, Date.parse('2026-06-13T22:43:29.000Z'));
  assert.equal(r.messages[2].role, 'unlabeled'); // 缺省角色
  assert.equal(r.messages[3].role, 'unlabeled');
  assert.equal(r.messages[3].meta!.originalRole, 'weird_role'); // 原样存证
  assert.equal(r.stats.byRole.user, 1);
});

test('L2：L1→L2 链路（clean 段带 ref → 直映射复原 role/ts，text 用清洗后版本）', async () => {
  const input: RawMessage[] = [
    { role: 'user', text: `我的手机号${FAKE_SENSITIVE.phone}`, ts: 1760000000000 },
    { role: 'assistant', text: '已记住', ts: 1760000001000 },
    { role: 'user', text: '钻石余额不足，请充值后继续使用', ts: 1760000002000 },
  ];
  const clean = cleanSegments(input, DEFAULT_CLEAN_CONFIG);
  assert.equal(clean.segments.length, 2); // 气泡噪音已滤
  assert.ok(clean.segments[0].text.includes('[已脱敏:手机号]'));
  const r = await structureMessages(clean.segments, {});
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].role, 'user'); // ref 复原
  assert.equal(r.messages[0].ts, 1760000000000);
  assert.ok(r.messages[0].text.includes('[已脱敏:手机号]')); // 清洗后正文
  assert.equal(r.messages[1].role, 'assistant');
});

/* ================================================================
 * 二、段头确定性解析
 * ===============================================================*/

test('L2：段头解析（说话人 + 时间 → ts，UTC 构造）', () => {
  const parsed = parseHeader('星见雅: 06-13 22:43:29', BASE_YEAR);
  assert.equal(parsed!.speaker, '星见雅');
  assert.equal(parsed!.ts, Date.UTC(2026, 5, 13, 22, 43, 29));
  assert.equal(parsed!.rawTime, '06-13 22:43:29');
  // 非法时间不炸（ts null）
  const bad = parseHeader('某人: 13-32 99:99:99', BASE_YEAR);
  assert.equal(bad!.ts, null);
  // 非段头
  assert.equal(parseHeader('随便一段文字', BASE_YEAR), null);
});

test('L2：roleAliases 最长命中（星见 不抢 星见雅；粘连尾巴容忍）', async () => {
  const segments: Segment[] = [
    { header: '星见雅: 06-13 22:43:29', text: 'A' },
    { header: '测试用户（芣苢）绝绝子: 06-13 22:43:21', text: 'B' },
    { header: 'dia_image1.jpeg)星见雅: 06-13 22:44:00', text: 'C' }, // 解析粘连尾巴
    { header: '陌生人甲: 06-13 22:45:00', text: 'D' }, // 未命中 → unlabeled
    { header: null, text: '散文本' }, // 无头段 → unlabeled
  ];
  const r = await structureMessages(segments, { roleAliases: ALIASES, baseYear: BASE_YEAR });
  assert.equal(r.messages[0].role, 'assistant');
  assert.equal(r.messages[0].meta!.speaker, '星见雅');
  assert.equal(r.messages[1].role, 'user');
  assert.equal(r.messages[2].role, 'assistant'); // 粘连尾巴仍命中
  assert.equal(r.messages[2].meta!.speaker, 'dia_image1.jpeg)星见雅');
  assert.equal(r.messages[3].role, 'unlabeled'); // 保留原文待标
  assert.equal(r.messages[3].meta!.pendingLabel, true);
  assert.equal(r.messages[4].role, 'unlabeled');
  assert.equal(r.stats.pendingLabel, 2);
});

/* ================================================================
 * 三、纯文本：LLM 分角色 / 无 key 降级
 * ===============================================================*/

test('L2：纯文本 LLM 分角色（mock，转写模板）', async () => {
  const mock = new MockLLMProvider('mock-struct', 'm', () =>
    JSON.stringify([
      { role: 'user', text: '今天天气怎么样' },
      { role: 'assistant', text: '晴朗微风，适合散步' },
    ]),
  );
  const r = await structureMessages('今天天气怎么样\n晴朗微风，适合散步', { provider: mock });
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].role, 'user');
  assert.equal(r.messages[1].role, 'assistant');
  assert.equal(r.stats.llmAssisted, 2);
  assert.ok(mock.calls[0].user!.includes('聊天记录')); // 转写模板已注入
});

test('L2：无 key 降级——纯文本保留原文待标，不报错', async () => {
  const r = await structureMessages('第一行内容\n第二行内容\n第三行内容', {});
  assert.equal(r.messages.length, 3);
  for (const m of r.messages) {
    assert.equal(m.role, 'unlabeled');
    assert.equal(m.meta!.pendingLabel, true);
    assert.equal(m.ts, null);
  }
  assert.equal(r.stats.pendingLabel, 3);
  assert.equal(r.stats.llmAssisted, 0);
});

test('L2：LLM 输出不可解析 → 该批降级保留原文（不报错）', async () => {
  const mock = new MockLLMProvider('mock-bad', 'm', () => '这不是 JSON');
  const r = await structureMessages('第一行\n第二行', { provider: mock });
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].role, 'unlabeled');
  assert.equal(r.messages[0].meta!.pendingLabel, true);
});

/* ================================================================
 * 四、宿主样本实战（L1 清洗 → L2 段头解析）
 * ===============================================================*/

test('L2：宿主样本实战（清洗段 → 段头解析出 assistant/user 时间线）', { skip: !loadHostSample() }, async () => {
  const sample = loadHostSample()!;
  const clean = cleanSegments(sample, DEFAULT_CLEAN_CONFIG);
  const r = await structureMessages(clean.segments, {
    roleAliases: ALIASES,
    baseYear: BASE_YEAR,
  });
  assert.ok(r.messages.length > 40, `宿主样本结构化消息数应 >40，实际 ${r.messages.length}`);
  // 星见雅/测试用户 双方都在（勘察：样本两轮重复去重后 user 侧共 7 条，全部正确识别）
  assert.ok(r.stats.byRole.assistant! > 20);
  assert.ok(r.stats.byRole.user! > 5);
  // 时间线可用（大部分消息有 ts）
  const withTs = r.messages.filter((m) => m.ts !== null).length;
  assert.ok(withTs > r.messages.length * 0.9, '90%+ 消息应解析出时间戳');
});

/* ================================================================
 * 五、合成全链（L1→L2：重复段去除后角色时间线完整）
 * ===============================================================*/

test('L2：合成数据 L1→L2（两轮重复去重 + 角色标注 + 脱敏透传）', async () => {
  const text = makeSyntheticChat({
    pairs: 6,
    withSensitive: true,
    withNoise: true,
    withDuplicateRound: true,
  });
  const clean = cleanSegments(text, DEFAULT_CLEAN_CONFIG);
  const r = await structureMessages(clean.segments, {
    roleAliases: ALIASES,
    baseYear: BASE_YEAR,
  });
  // 12 对消息 × 2 轮 → 去重后约 13 条（含身份证一条 + 气泡被滤）
  assert.ok(r.messages.length >= 12 && r.messages.length <= 15, `消息数 ${r.messages.length}`);
  // 敏感字段透传为 0
  const joined = r.messages.map((m) => m.text).join('\n');
  assert.equal(joined.includes(FAKE_SENSITIVE.phone), false);
  assert.equal(joined.includes(FAKE_SENSITIVE.idCard18), false);
  assert.equal(joined.includes(FAKE_SENSITIVE.studentId), false);
  // 双角色都有
  assert.ok(r.stats.byRole.user! > 0);
  assert.ok(r.stats.byRole.assistant! > 0);
});
