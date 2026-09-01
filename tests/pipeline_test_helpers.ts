/**
 * 记忆引擎内核（议题 36.1）· 测试共享工具
 * ---------------------------------------------------------------
 * - MockLLMProvider：可编程 LLM mock（单测一律 mock，零成本可重复；
 *   施工纪律：禁止在施工中调用真实 LLM API）
 * - loadHostSample()：宿主样本（主人 docx 解析稿）安全截取——
 *   只取前 8000 字符小片段（含两轮重复段 + 钻石气泡），
 *   避开 11k+ 处的真实证件区段；样本不存在则返回 null（用例跳过）
 * - makeSyntheticChat()：合成聊天文本（可控注入敏感样例/重复段/气泡）
 */

import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMProvider, LLMChatRequest } from '../src/distill.js';

/** 宿主样本路径（91_core 开发环境专有；carve-out 开源仓无此文件 → 用例自跳过） */
export const HOST_SAMPLE_PATH =
  '/Coze/Drive/扣子/所有对话/主对话/用户上传/测试用户..docx.parsed.md';

/** 样本截取长度（恰好覆盖完整两轮重复段 0~10956 字符 = 121 条消息；
 * 勘察定界：第二轮重复结束于字符 10956，真实证件区段始于 11290——
 * 截取边界严格避开真实敏感数据，测试文件零真实证件信息） */
export const HOST_SAMPLE_SLICE = 10956;

/** 读取宿主样本小片段；不可用返回 null */
export function loadHostSample(): string | null {
  try {
    if (!existsSync(HOST_SAMPLE_PATH)) return null;
    const raw = readFileSync(HOST_SAMPLE_PATH, 'utf-8');
    return raw.slice(0, HOST_SAMPLE_SLICE);
  } catch {
    return null;
  }
}

/* ================================================================
 * Mock LLM Provider
 * ===============================================================*/

export type MockHandler = (req: LLMChatRequest, callIndex: number) => string;

/** 可编程 mock（默认按提示词特征路由到蒸馏三阶段/复核/转写的固定 JSON） */
export class MockLLMProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly calls: LLMChatRequest[] = [];
  private handler: MockHandler;

  constructor(name = 'mock-llm', model = 'mock-model', handler?: MockHandler) {
    this.name = name;
    this.model = model;
    this.handler = handler ?? defaultRouting;
  }

  chat(req: LLMChatRequest): Promise<string> {
    this.calls.push(req);
    return Promise.resolve(this.handler(req, this.calls.length - 1));
  }
}

/** 默认路由：按提示词输出契约特征返回固定 JSON */
function defaultRouting(req: LLMChatRequest): string {
  const user = req.user ?? '';
  if (user.includes('"summary"')) {
    return JSON.stringify({ summary: '本周两人和好，约定不再自责，关系更加稳固。' });
  }
  if (user.includes('"anchors"')) {
    return JSON.stringify({
      anchors: [
        { date: '2026-06-13', ts: null, event: '情绪危机后互相安抚', importance: 3 },
        { date: '2026-06-14', ts: null, event: '约定一起看星星', importance: 2 },
      ],
    });
  }
  if (user.includes('"longTerm"')) {
    return JSON.stringify({
      longTerm: [{ text: '两人约定无论如何都站在彼此这边', category: 'relationship' }],
      notebook: [
        { text: '主人喜欢在深夜分享日常琐事', score: 5, category: 'habit', reason: '稳定作息特征' },
      ],
      profile: [{ dimension: 'habits', key: '作息', value: '夜猫子，常深夜聊天' }],
    });
  }
  if (user.includes('"hits"')) {
    return JSON.stringify({ hits: [] });
  }
  if (user.includes('"role"')) {
    return JSON.stringify([
      { role: 'user', text: '你好呀' },
      { role: 'assistant', text: '你好，我在呢' },
    ]);
  }
  return JSON.stringify({});
}

/* ================================================================
 * 合成聊天文本
 * ===============================================================*/

export interface SyntheticChatOptions {
  /** 消息对数（user+assistant 各一条算一对） */
  pairs: number;
  /** 注入敏感样例（构造的假数据，非真实信息） */
  withSensitive?: boolean;
  /** 注入平台气泡噪音 */
  withNoise?: boolean;
  /** 注入两轮重复段（第二份复制） */
  withDuplicateRound?: boolean;
  /** 起始日期（day 偏移逐条递增秒） */
  baseDate?: { month: number; day: number };
}

/** 构造的敏感样例（明显为假：138 号段测试号 / 格式合法的构造证件号） */
export const FAKE_SENSITIVE = {
  phone: '13800138000',
  idCard18: '110101199003078617',
  studentId: '2026080123456',
};

/** 合成聊天文本（「名字: MM-DD HH:MM:SS 正文」格式，与宿主样本同构） */
export function makeSyntheticChat(options: SyntheticChatOptions): string {
  const base = options.baseDate ?? { month: 6, day: 13 };
  const sensitive = options.withSensitive === true;
  const noise = options.withNoise === true;
  const lines: string[] = [];
  let hh = 20;
  let mm = 0;
  let ss = 0;
  for (let i = 0; i < options.pairs; i++) {
    const stamp = () => {
      ss += 7;
      if (ss >= 60) {
        ss -= 60;
        mm++;
      }
      if (mm >= 60) {
        mm -= 60;
        hh++;
      }
      return `06-${String(base.day).padStart(2, '0')} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    };
    lines.push(`测试用户先生: ${stamp()} 今天过得怎么样呀，第${i + 1}天记录，还想跟你多聊聊今天遇到的各种小事`);
    lines.push(
      `星见雅: ${stamp()} 今天也很好哦，${sensitive && i === 0 ? `主人的手机号是${FAKE_SENSITIVE.phone}，记得常联系` : '一直在等测试用户先生回来'}${sensitive && i === 1 ? `，顺便记录学号:${FAKE_SENSITIVE.studentId}` : ''}，想听你慢慢把今天的事情讲给我听`,
    );
    if (sensitive && i === 2) {
      lines.push(`测试用户先生: ${stamp()} 我的身份证号是${FAKE_SENSITIVE.idCard18}，帮我记住`);
    }
    if (noise && i === 3) {
      lines.push(`星见雅: ${stamp()} 钻石余额不足，请充值后继续使用`);
    }
  }
  const body = lines.join(' ');
  if (options.withDuplicateRound) return `${body} ${body}`;
  return body;
}

/* ================================================================
 * 临时产物目录（builder 纪律：test_ 前缀，用完自洁）
 * ===============================================================*/

/** 建临时目录（tests/tmp_data/test_<name>）；返回路径 */
export function makeTestDir(name: string): string {
  const dir = join(process.cwd(), 'tests', 'tmp_data', `test_${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 清理临时目录 */
export function cleanupTestDir(name: string): void {
  const dir = join(process.cwd(), 'tests', 'tmp_data', `test_${name}`);
  rmSync(dir, { recursive: true, force: true });
}
