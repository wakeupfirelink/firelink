/*
 * 传火（firelink）· 开源记忆加工内核 · L0 适配器 · SillyTavern 聊天记录
 * Copyright (c) 2026 传火项目贡献者
 *
 * SPDX-License-Identifier: MIT
 *
 * 本文件是「传火」开源子集的一部分（议题 36 施工案 36.2），按 MIT 许可证发布。
 * 开源边界：本目录（open/adapters/）自包含——仅依赖 open/ 内组件与 node: 内置，
 * 零 npm 外部依赖、零闭源依赖；本许可仅覆盖本开源组件，其余组件不受本许可约束。
 * 完整许可文本：https://opensource.org/licenses/MIT
 */

/**
 * L0 适配器：SillyTavern jsonl 聊天记录（社区标准格式，36 施工案 36.2）
 * ---------------------------------------------------------------
 * 每行一个消息对象：{ name, is_user, is_system, send_date, mes, ... }
 * - 角色：is_system→system / is_user→user / 其余→assistant
 * - 文本：mes 字段（swipes 不取，按 mes 主版本）
 * - send_date 多形态：epoch 毫秒串 / epoch 秒数值 / ISO 串 /
 *   人性化串（"May 19, 2023 10:07pm"，UTC 构造保证跨环境可复现）
 * - 首行会话元数据变体（{user_name, character_name}，无 mes）：不入消息，
 *   记入 result.meta
 * - 不可解析行 / mes 非 string → 跳过（计数入 skipped）
 * 输入：jsonl 文本 / 已解析对象 / 文件路径。
 */

import {
  buildL0Result,
  resolveInputText,
  tryParseJson,
  type L0Adapter,
  type L0Input,
  type L0Result,
  type MessageRole,
  type RawMessage,
} from './common.js';

/* ================================================================
 * 一、主转换
 * ===============================================================*/

export async function adaptStChatlog(input: L0Input): Promise<L0Result> {
  const text = await resolveInputText(input, 'st-chatlog');
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new Error('st-chatlog 适配器：输入为空（期待 SillyTavern jsonl 聊天记录）');
  }

  const messages: RawMessage[] = [];
  const chatMeta: Record<string, unknown> = {};
  let skipped = 0;
  for (const line of lines) {
    const parsed = tryParseJson(line);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      skipped++;
      continue;
    }
    const rec = parsed as Record<string, unknown>;

    // 首行会话元数据变体（无 mes，含 user_name/character_name）
    if (!('mes' in rec)) {
      if ('user_name' in rec || 'character_name' in rec) {
        if (typeof rec.user_name === 'string') chatMeta.user_name = rec.user_name;
        if (typeof rec.character_name === 'string') chatMeta.character_name = rec.character_name;
        continue;
      }
      skipped++;
      continue;
    }
    if (typeof rec.mes !== 'string' || rec.mes.trim().length === 0) {
      skipped++;
      continue;
    }

    messages.push({
      role: stRole(rec),
      text: rec.mes.trim(),
      ts: parseSendDate(rec.send_date),
      meta: {
        source: 'st-chatlog',
        ...(typeof rec.name === 'string' && rec.name.length > 0 ? { speaker: rec.name } : {}),
        ...(rec.send_date !== undefined ? { rawTime: String(rec.send_date) } : {}),
      },
    });
  }

  if (messages.length === 0) {
    throw new Error('st-chatlog 适配器：未识别到任何消息行（期待含 mes/is_user 字段的 jsonl）');
  }

  return buildL0Result(messages, {
    skipped,
    meta: {
      adapter: 'st-chatlog',
      ...chatMeta,
      lines: lines.length,
      skipped,
    },
  });
}

/* ================================================================
 * 二、内部工具
 * ===============================================================*/

function stRole(rec: Record<string, unknown>): MessageRole {
  if (rec.is_system === true) return 'system';
  if (rec.is_user === true) return 'user';
  return 'assistant';
}

/** send_date 多形态解析：epoch 毫秒串/秒数值 → ms；ISO 串；人性化英文日期 */
function parseSendDate(value: unknown): number | null {
  if (typeof value === 'number') return epochNormalize(value);
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s.length === 0) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return epochNormalize(Number(s));
  const ms = Date.parse(s); // ISO 等标准形态
  if (!Number.isNaN(ms)) return ms;
  return parseHumanizedDate(s);
}

/** epoch 秒/毫秒归一（< 1e12 视为秒） */
function epochNormalize(n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** 人性化日期（SillyTavern 惯例："May 19, 2023 10:07pm" / 带秒变体）→ UTC epoch ms */
function parseHumanizedDate(s: string): number | null {
  const m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i);
  if (!m) return null;
  const [, monthName, dd, yyyy, hh, mi, ss, ap] = m;
  const month = MONTHS.findIndex((name) => name.startsWith(monthName.toLowerCase()));
  if (month < 0) return null;
  let hour = Number(hh) % 12;
  if (ap.toLowerCase() === 'p') hour += 12;
  const ts = Date.UTC(Number(yyyy), month, Number(dd), hour, Number(mi), ss !== undefined ? Number(ss) : 0);
  return Number.isNaN(ts) ? null : ts;
}

/* ================================================================
 * 三、适配器对象
 * ===============================================================*/

export const stChatlogAdapter: L0Adapter = {
  name: 'st-chatlog',
  label: 'SillyTavern 聊天记录',
  description:
    '社区标准 jsonl 格式（每行 {name, is_user, is_system, send_date, mes}；send_date 支持 epoch 秒/毫秒、ISO、人性化日期）',
  convert: (input) => adaptStChatlog(input),
};
