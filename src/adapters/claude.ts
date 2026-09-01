/*
 * 传火（firelink）· 开源记忆加工内核 · L0 适配器 · Claude 官方导出
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
 * L0 适配器：Claude 官方 conversations.json（36 施工案 36.2）
 * ---------------------------------------------------------------
 * chat_messages 数组直接映射（映射难度低）：
 * - sender：human→user / assistant→assistant（其余值保留存证并标 unlabeled）
 * - 文本：message.text 优先，缺失时拼接 content 块（type: 'text'）
 * - created_at（ISO 8601）→ epoch ms；空消息跳过
 * 输入：conversations.json 文本 / 已解析对象 / 文件路径。
 */

import {
  buildL0Result,
  parseIsoTs,
  resolveInputText,
  tryParseJson,
  type L0Adapter,
  type L0Input,
  type L0Result,
  type MessageRole,
  type RawMessage,
} from './common.js';

/* ================================================================
 * 一、官方导出形状（公开格式子集，仅取所需字段）
 * ===============================================================*/

interface ClaudeMessage {
  uuid?: string;
  text?: string;
  content?: Array<{ type?: string; text?: string }>;
  sender?: string;
  created_at?: string;
}

interface ClaudeConversation {
  uuid?: string;
  name?: string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ClaudeMessage[];
}

/* ================================================================
 * 二、主转换
 * ===============================================================*/

export async function adaptClaude(input: L0Input): Promise<L0Result> {
  const text = await resolveInputText(input, 'claude');
  const parsed = tryParseJson(text);
  const conversations = extractConversations(parsed);
  if (conversations.length === 0) {
    throw new Error(
      'claude 适配器：未识别到会话数据（期待官方导出 conversations.json：含 chat_messages 的会话数组）',
    );
  }

  const messages: RawMessage[] = [];
  let skipped = 0;
  conversations.forEach((conv, conversationIndex) => {
    for (const m of conv.chat_messages ?? []) {
      const body = claudeMessageText(m);
      if (body.length === 0) {
        skipped++;
        continue;
      }
      messages.push({
        role: mapSender(m.sender),
        text: body,
        ts: parseIsoTs(m.created_at),
        meta: {
          source: 'claude',
          sender: m.sender ?? null,
          conversationName: conv.name ?? null,
          conversationIndex,
        },
      });
    }
  });

  return buildL0Result(messages, {
    skipped,
    meta: { adapter: 'claude', conversations: conversations.length, skipped },
  });
}

/* ================================================================
 * 三、内部工具
 * ===============================================================*/

function extractConversations(parsed: unknown): ClaudeConversation[] {
  if (Array.isArray(parsed)) return parsed.filter(hasChatMessages);
  if (parsed !== null && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.conversations)) {
      return obj.conversations.filter(hasChatMessages);
    }
    if (hasChatMessages(obj)) return [obj];
  }
  return [];
}

function hasChatMessages(v: unknown): v is ClaudeConversation {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as ClaudeConversation).chat_messages)
  );
}

/** 消息文本：text 字段优先，缺失时拼接 content 文本块 */
function claudeMessageText(m: ClaudeMessage): string {
  if (typeof m.text === 'string' && m.text.trim().length > 0) return m.text.trim();
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => (b.text as string).trim())
      .filter((t) => t.length > 0)
      .join('\n');
  }
  return '';
}

function mapSender(sender: string | undefined): MessageRole {
  if (sender === 'human') return 'user';
  if (sender === 'assistant') return 'assistant';
  if (sender === 'system') return 'system';
  return 'unlabeled';
}

/* ================================================================
 * 四、适配器对象
 * ===============================================================*/

export const claudeAdapter: L0Adapter = {
  name: 'claude',
  label: 'Claude 官方导出',
  description:
    '官方 conversations.json（会话数组，chat_messages 直接映射：human→user / assistant→assistant，created_at ISO→ms）',
  convert: (input) => adaptClaude(input),
};
