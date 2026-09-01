/*
 * 传火（firelink）· 开源记忆加工内核 · 记忆包导出
 * Copyright (c) 2026 传火项目贡献者
 *
 * SPDX-License-Identifier: MIT
 *
 * 本文件是「传火」开源子集的一部分（议题 36 施工案 36.1），按 MIT 许可证发布。
 * 开源边界：本目录（open/）自包含，不依赖任何闭源模块与 npm 外部依赖；
 * 本许可仅覆盖本目录（open/）开源组件；本目录外组件不受本许可约束。
 * 完整许可文本：https://opensource.org/licenses/MIT
 */

/**
 * 记忆包导出（mempack）· 三格式
 * ---------------------------------------------------------------
 * 36 施工案 v1.2 传导拍板「三格式导出顶配」——传火不做数据锁死：
 * 1. .firelink.jsonl —— 首行 meta 自描述（schema 版本 / 字段说明 /
 *    生成器 / 统计），后续行完整统一消息 schema；
 * 2. messages.jsonl   —— 通用消息格式（role/content + ts，可直喂 LLM）；
 * 3. markdown          —— 人类可读版（时间线排版，按日期分组）。
 *
 * 三格式由同一 UnifiedMessage[] 生成 → 内容一致性由构造保证
 * （验收：消息数 / 时间跨度 / 抽样文本一致）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UnifiedMessage } from './structure.js';

/** 记忆包 schema 版本 */
export const MEMPACK_SCHEMA_VERSION = '1.0';

/** 生成器标识 */
export const MEMPACK_GENERATOR = { name: 'chuanhuo-mempack', version: '1.0.0' } as const;

/* ================================================================
 * 一、自描述 meta（.firelink.jsonl 首行）
 * ===============================================================*/

export interface MemPackStats {
  messageCount: number;
  timeSpan: { start: string | null; end: string | null };
  byRole: Record<string, number>;
}

export interface MemPackMeta {
  type: 'mempack-meta';
  schemaVersion: string;
  generator: { name: string; version: string };
  createdAt: string;
  /** 字段说明（自描述：下游消费方无需读文档即可理解行格式） */
  fields: Record<string, string>;
  stats: MemPackStats;
  /** 来源标注（可选） */
  source?: string;
}

/** 默认字段说明（自描述文本） */
export const MEMPACK_FIELD_DOCS: Record<string, string> = {
  type: '行类型：mempack-meta（首行自描述）| message（消息行）',
  ts: 'epoch 毫秒时间戳；null = 未知时间',
  role: 'user | assistant | system | unlabeled（保留原文待标）',
  text: '消息正文（已清洗脱敏）',
  meta: '附加元数据：speaker（说话人）、rawTime（原始时间串）、source（来源）、pendingLabel（待标注）等',
};

export interface MemPackOptions {
  title?: string;
  createdAt?: string;
  source?: string;
}

/* ================================================================
 * 二、三格式导出
 * ===============================================================*/

/** 统计（一致性验收的公共基准） */
export function mempackStats(messages: UnifiedMessage[]): MemPackStats {
  const byRole: Record<string, number> = {};
  let min: number | null = null;
  let max: number | null = null;
  for (const m of messages) {
    byRole[m.role] = (byRole[m.role] ?? 0) + 1;
    if (m.ts !== null) {
      if (min === null || m.ts < min) min = m.ts;
      if (max === null || m.ts > max) max = m.ts;
    }
  }
  return {
    messageCount: messages.length,
    timeSpan: {
      start: min === null ? null : new Date(min).toISOString(),
      end: max === null ? null : new Date(max).toISOString(),
    },
    byRole,
  };
}

/** 格式 1：.firelink.jsonl（首行 meta 自描述 + 完整消息行） */
export function exportWakeupMemJsonl(messages: UnifiedMessage[], options: MemPackOptions = {}): string {
  const meta: MemPackMeta = {
    type: 'mempack-meta',
    schemaVersion: MEMPACK_SCHEMA_VERSION,
    generator: { ...MEMPACK_GENERATOR },
    createdAt: options.createdAt ?? new Date().toISOString(),
    fields: { ...MEMPACK_FIELD_DOCS },
    stats: mempackStats(messages),
    ...(options.source ? { source: options.source } : {}),
  };
  const lines: string[] = [JSON.stringify(meta)];
  for (const m of messages) {
    lines.push(
      JSON.stringify({
        type: 'message',
        ts: m.ts,
        role: m.role,
        text: m.text,
        ...(m.meta !== undefined ? { meta: m.meta } : {}),
      }),
    );
  }
  return lines.join('\n') + '\n';
}

/** 格式 2：messages.jsonl（通用消息格式：role/content + ts） */
export function exportMessagesJsonl(messages: UnifiedMessage[]): string {
  return (
    messages
      .map((m) => JSON.stringify({ ts: m.ts, role: m.role, content: m.text }))
      .join('\n') + '\n'
  );
}

/** 格式 3：markdown 可读版（时间线排版，按日期分组） */
export function exportMarkdown(messages: UnifiedMessage[], options: MemPackOptions = {}): string {
  const stats = mempackStats(messages);
  const title = options.title ?? '记忆包';
  const head = [
    `# ${title}`,
    '',
    `- 生成器：${MEMPACK_GENERATOR.name} v${MEMPACK_GENERATOR.version}`,
    `- 生成时间：${options.createdAt ?? new Date().toISOString()}`,
    `- 消息数：${stats.messageCount}`,
    `- 时间跨度：${stats.timeSpan.start ?? '未知'} ~ ${stats.timeSpan.end ?? '未知'}`,
    `- 角色分布：${Object.entries(stats.byRole)
      .map(([r, n]) => `${r}=${n}`)
      .join(' / ')}`,
    ...(options.source ? [`- 来源：${options.source}`] : []),
    '',
  ];

  const body: string[] = [];
  let currentDate = '';
  for (const m of messages) {
    const date = m.ts === null ? '未知时间' : new Date(m.ts).toISOString().slice(0, 10);
    if (date !== currentDate) {
      currentDate = date;
      body.push(`## ${date}`, '');
    }
    const time = m.ts === null ? '--:--' : new Date(m.ts).toISOString().slice(11, 19);
    const speaker =
      typeof m.meta?.speaker === 'string' ? (m.meta.speaker as string) : roleLabel(m.role);
    body.push(`- **${time}** ${speaker}：${m.text}`);
  }
  return head.concat(body).join('\n') + '\n';
}

function roleLabel(role: string): string {
  switch (role) {
    case 'user':
      return '主人';
    case 'assistant':
      return '伴侣';
    case 'system':
      return '系统';
    default:
      return '（待标注）';
  }
}

/* ================================================================
 * 三、三格式一次产出 + 落盘
 * ===============================================================*/

/** 三格式内容包 */
export interface MemPackBundle {
  /** .firelink.jsonl 内容（含首行 meta） */
  wakeupMem: string;
  /** messages.jsonl 内容 */
  messages: string;
  /** markdown 可读版内容 */
  markdown: string;
  stats: MemPackStats;
}

/** 三格式一次产出（同源 messages → 一致性由构造保证） */
export function exportMemPack(messages: UnifiedMessage[], options: MemPackOptions = {}): MemPackBundle {
  return {
    wakeupMem: exportWakeupMemJsonl(messages, options),
    messages: exportMessagesJsonl(messages),
    markdown: exportMarkdown(messages, options),
    stats: mempackStats(messages),
  };
}

/** 写盘产物报告 */
export interface MemPackFiles {
  dir: string;
  /** 三个文件的完整路径 */
  files: { wakeupMem: string; messages: string; markdown: string };
}

/** 三格式落盘（文件名：<prefix>.firelink.jsonl / <prefix>.messages.jsonl / <prefix>.md） */
export function writeMemPackFiles(
  dir: string,
  messages: UnifiedMessage[],
  options: MemPackOptions & { prefix?: string } = {},
): MemPackFiles {
  mkdirSync(dir, { recursive: true });
  const prefix = options.prefix ?? 'mempack';
  const wakeupMem = join(dir, `${prefix}.firelink.jsonl`);
  const messagesFile = join(dir, `${prefix}.messages.jsonl`);
  const markdown = join(dir, `${prefix}.md`);
  const bundle = exportMemPack(messages, options);
  writeFileSync(wakeupMem, bundle.wakeupMem, 'utf-8');
  writeFileSync(messagesFile, bundle.messages, 'utf-8');
  writeFileSync(markdown, bundle.markdown, 'utf-8');
  return { dir, files: { wakeupMem, messages: messagesFile, markdown } };
}
