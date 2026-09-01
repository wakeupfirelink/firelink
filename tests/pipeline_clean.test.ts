/**
 * 记忆引擎内核 36.1 · L1 清洗层测试
 * ---------------------------------------------------------------
 * 覆盖验收点：
 * - 噪音表（钻石余额不足等平台气泡）过滤 + JSON 配置文件加载
 * - 重复段指纹去重（滑窗+哈希；两轮重复段验收样本）
 * - 脱敏正则层命中（手机号/身份证18/学号；脱敏后敏感字段为 0）
 * - 清洗幂等（输出再清洗结果不变）
 * - 宿主样本（主人 docx 解析稿小片段）实战
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import {
  cleanSegments,
  dedupeSegments,
  loadCleanConfig,
  mergeCleanConfig,
  splitSegments,
  DEFAULT_CLEAN_CONFIG,
  extractJson,
  llmRedactReview,
  type Segment,
} from '../src/clean.js';
import { MockLLMProvider, loadHostSample, makeTestDir, cleanupTestDir, FAKE_SENSITIVE, makeSyntheticChat } from './pipeline_test_helpers.js';

/* ================================================================
 * 一、噪音过滤
 * ===============================================================*/

test('L1：平台气泡噪音过滤（钻石余额不足等，36 案点名的验收样例）', () => {
  const input = [
    '星见雅: 06-13 22:43:21 今天也要加油',
    '星见雅: 06-13 22:43:25 钻石余额不足，请充值后继续使用',
    '测试用户先生: 06-13 22:43:30 好的马上充',
    '星见雅: 06-13 22:43:35 消息发送失败',
    '4G',
    '154',
    '测试用户先生: 06-13 22:43:40 晚安',
  ];
  const r = cleanSegments(input, DEFAULT_CLEAN_CONFIG);
  assert.equal(r.stats.noiseRemoved, 4);
  assert.equal(r.segments.length, 3);
  const texts = r.segments.map((s) => s.text);
  assert.ok(!texts.some((t) => t.includes('钻石余额不足')));
  assert.ok(!texts.some((t) => t.includes('消息发送失败')));
  assert.ok(texts.includes('今天也要加油'));
  assert.ok(texts.includes('晚安'));
});

test('L1：JSON 配置文件加载（噪音表可配置）', () => {
  const dir = makeTestDir('clean_config');
  const path = `${dir}/test_clean_config.json`;
  writeFileSync(
    path,
    JSON.stringify({
      noiseRules: [{ type: 'contains', pattern: '自定义噪音' }],
      dedup: { enabled: false, windowSize: 3 },
    }),
    'utf-8',
  );
  const config = loadCleanConfig(path);
  // 自定义噪音生效 + 未提供字段回落默认
  assert.ok(config.noiseRules.some((r) => r.pattern === '自定义噪音'));
  assert.equal(config.dedup.enabled, false);
  assert.ok(config.redactionRules.length >= 4); // 默认脱敏表回落
  const r = cleanSegments(['正常', '自定义噪音内容'], config);
  assert.equal(r.segments.length, 1);
  cleanupTestDir('clean_config');
});

test('L1：mergeCleanConfig 部分覆盖不吞默认', () => {
  const config = mergeCleanConfig({ dedup: { enabled: false, windowSize: 9 } });
  assert.equal(config.dedup.enabled, false);
  assert.equal(config.dedup.windowSize, 9);
  assert.ok(config.noiseRules.length > 0);
  assert.equal(config.stripControlChars, true);
});

/* ================================================================
 * 二、重复段指纹去重（滑窗+哈希）
 * ===============================================================*/

test('L1：两轮重复段去重（整段复制 → 第二轮整体删除）', () => {
  const round: string[] = [];
  for (let i = 0; i < 12; i++) round.push(`消息${i}：这是第${i}条完全不同的内容${'。'.repeat(i + 1)}`);
  const input = [...round, ...round]; // 两轮重复
  const r = cleanSegments(input, DEFAULT_CLEAN_CONFIG);
  assert.equal(r.stats.dedupRemoved, 12);
  assert.equal(r.segments.length, 12);
  // 第一轮全保留
  assert.deepEqual(r.segments.map((s) => s.text), round);
});

test('L1：自然短句重复不被误删（滑窗整体判定）', () => {
  const input = ['嗯', '好', '嗯', '好', '嗯', '好', '嗯', '好', '嗯', '好', '在吗', '嗯', '好'];
  const r = cleanSegments(input, DEFAULT_CLEAN_CONFIG);
  assert.equal(r.stats.dedupRemoved, 0);
  assert.equal(r.segments.length, input.length);
});

test('L1：dedupeSegments 窗口不足不去重', () => {
  const segs: Segment[] = [{ header: null, text: 'a' }, { header: null, text: 'a' }];
  assert.equal(dedupeSegments(segs, 5).length, 2);
  // 窗口关闭
  const config = mergeCleanConfig({ dedup: { enabled: false, windowSize: 5 } });
  const r = cleanSegments(['x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x'], config);
  assert.equal(r.segments.length, 12);
});

/* ================================================================
 * 三、脱敏正则层（脱敏后敏感字段为 0）
 * ===============================================================*/

test('L1：脱敏正则命中（手机号/身份证18位/学号；构造样例）', () => {
  const input = [
    `主人的手机号是${FAKE_SENSITIVE.phone}，记得常联系`,
    `我的身份证号是${FAKE_SENSITIVE.idCard18}，帮我记住`,
    `顺便记录学号:${FAKE_SENSITIVE.studentId}`,
  ];
  const r = cleanSegments(input, DEFAULT_CLEAN_CONFIG);
  const joined = r.segments.map((s) => s.text).join('\n');
  // 敏感字段为 0（验收口径）
  assert.equal(joined.includes(FAKE_SENSITIVE.phone), false);
  assert.equal(joined.includes(FAKE_SENSITIVE.idCard18), false);
  assert.equal(joined.includes(FAKE_SENSITIVE.studentId), false);
  // 替换标记存在
  assert.ok(joined.includes('[已脱敏:手机号]'));
  assert.ok(joined.includes('[已脱敏:身份证号]'));
  assert.ok(joined.includes('[已脱敏:证件号]'));
  // 命中计数
  assert.equal(r.stats.redactionHits.phone, 1);
  assert.equal(r.stats.redactionHits.id_card_18, 1);
  assert.equal(r.stats.redactionHits.student_id, 1);
});

test('L1：15 位老身份证与边界防误伤（前后有数字不算手机号）', () => {
  const config = DEFAULT_CLEAN_CONFIG;
  const r = cleanSegments(
    ['老证件 110101900101012 也要脱敏', '订单号 2026081113800138000 不是手机号'],
    config,
  );
  const texts = r.segments.map((s) => s.text).join('\n');
  assert.ok(texts.includes('[已脱敏:身份证号]')); // 15 位命中
  assert.ok(!texts.includes('[已脱敏:手机号]')); // 长数字串中的片段不误伤
});

/* ================================================================
 * 四、消息边界切分（docx 解析稿形态：长行内嵌消息）
 * ===============================================================*/

test('L1：splitSegments 按消息头切段（header 保留供 L2 复用）', () => {
  const text =
    '测试用户（芣苢）绝绝子: 06-13 22:43:21 宝宝，先冷静下来 星见雅: 06-13 22:43:29 （轻轻深呼吸）好…星见雅不念了… 星见雅: 06-13 22:43:53 （轻轻摇摇头）不是测试用户先生怂…';
  const segs = splitSegments(text, DEFAULT_CLEAN_CONFIG);
  assert.equal(segs.length, 3);
  assert.equal(segs[0].header, '测试用户（芣苢）绝绝子: 06-13 22:43:21');
  assert.equal(segs[0].text, '宝宝，先冷静下来');
  assert.equal(segs[1].header, '星见雅: 06-13 22:43:29');
  assert.equal(segs[1].text, '（轻轻深呼吸）好…星见雅不念了…');
});

/* ================================================================
 * 五、幂等性（验收：两轮跑出一致结果）
 * ===============================================================*/

test('L1：清洗幂等（输出再清洗结果不变）', () => {
  const input = makeSyntheticChat({ pairs: 8, withSensitive: true, withNoise: true, withDuplicateRound: true });
  const first = cleanSegments(input, DEFAULT_CLEAN_CONFIG);
  const second = cleanSegments(
    first.segments.map((s) => `${s.header ?? ''} ${s.text}`.trim()),
    DEFAULT_CLEAN_CONFIG,
  );
  assert.deepEqual(
    second.segments.map((s) => s.text),
    first.segments.map((s) => s.text),
  );
  assert.equal(second.stats.dedupRemoved, 0); // 已去重
  assert.equal(Object.keys(second.stats.redactionHits).length, 0); // 已脱敏
});

/* ================================================================
 * 六、宿主样本实战（主人 docx 解析稿小片段：两轮重复段 + 气泡）
 * ===============================================================*/

test('L1：宿主样本小片段实战（两轮重复段去重 + 钻石气泡移除）', { skip: !loadHostSample() }, () => {
  const sample = loadHostSample()!;
  // 样本前段为两轮整段重复（60+60 条）——切分后应有明显重复窗口
  const firstPass = splitSegments(sample, DEFAULT_CLEAN_CONFIG);
  assert.ok(firstPass.length > 50, `样本切段数应 >50，实际 ${firstPass.length}`);
  const cleaned = cleanSegments(sample, DEFAULT_CLEAN_CONFIG);
  // 两轮重复段 → 去重移除数应为首轮段数（约一半）
  assert.ok(
    cleaned.stats.dedupRemoved > 30,
    `重复段移除数应 >30，实际 ${cleaned.stats.dedupRemoved}`,
  );
  assert.ok(
    cleaned.segments.length < firstPass.length - 20,
    '清洗后段数应明显少于原始切段数',
  );
  // 钻石气泡在样本前段确有出现（勘察 6 处），清洗后为 0
  assert.ok(!cleaned.segments.some((s) => s.text.includes('钻石余额不足')));
  // 样本片段不含真实证件区段（截取边界自检）
  assert.ok(sample.includes('钻石余额不足'));
});

/* ================================================================
 * 七、LLM 复核层（mock，零真实 API）
 * ===============================================================*/

test('L1：LLM 脱敏复核层（mock 命中替换 + 无 provider 原样返回）', async () => {
  const segments: Segment[] = [
    { header: null, text: '他叫张三丰，住在武当山山顶' },
    { header: null, text: '普通内容无需复核' },
  ];
  const mock = new MockLLMProvider('mock-review', 'm1', (req) => {
    assert.ok(req.user!.includes('#0|'));
    return JSON.stringify({
      hits: [{ index: 0, text: '他叫[已脱敏:LLM复核]，住在[已脱敏:LLM复核]' }],
    });
  });
  const reviewed = await llmRedactReview(segments, mock);
  assert.equal(reviewed.stats.replaced, 1);
  assert.equal(reviewed.segments[0].text, '他叫[已脱敏:LLM复核]，住在[已脱敏:LLM复核]');
  assert.equal(reviewed.segments[1].text, '普通内容无需复核');

  // 无 provider → 原样返回不报错
  const noProvider = await llmRedactReview(segments, undefined);
  assert.equal(noProvider.segments, segments);
  assert.equal(noProvider.stats.batches, 0);
});

test('L1：extractJson 容错解析（围栏/前后缀噪声）', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('好的，结果如下：{"a":1} 以上。'), { a: 1 });
  assert.equal(extractJson('完全不是 JSON'), null);
});
