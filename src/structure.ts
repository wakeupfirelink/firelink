/*
 * 传火（firelink）· 开源记忆加工内核 · L2 结构化层
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
 * L2 结构化层：统一消息 schema
 * ---------------------------------------------------------------
 * 统一 schema：{ ts, role, text, meta }
 * - 结构化源（RawMessage[]）→ 直映射
 * - L1 清洗输出的段（Segment[]，带消息头）→ 确定性解析（说话人 + 时间）
 *   说话人 → role 映射走 roleAliases（含子串匹配，容忍「图片名)星见雅」
 *   之类的解析粘连尾巴）；未命中 → unlabeled（保留原文待标，meta.speaker 存证）
 * - 纯文本（string）→ LLM 分角色（BYO key；P0 转写模板沉淀于此）；
 *   无 key 自动降级：按行拆为 unlabeled 消息，meta.pendingLabel = true，
 *   不报错（36 施工案拍板：L2 纯文本保留原文待标）
 *
 * 内核无状态；时间统一 epoch ms（无年份的 MM-DD 以 baseYear 补全，
 * 用 UTC 构造保证跨环境可复现；meta.rawTime 保留原始时间串）。
 */

import type { Segment } from './clean.js';

/* ================================================================
 * 一、统一消息 schema
 * ===============================================================*/

export type MessageRole = 'user' | 'assistant' | 'system' | 'unlabeled';

/** 统一消息（L2 产物，mempack / distill / L4 的公共输入） */
export interface UnifiedMessage {
  /** epoch ms；无时间信息为 null */
  ts: number | null;
  role: MessageRole;
  text: string;
  meta?: Record<string, unknown>;
}

/** 结构化源的原始消息形（L0 适配器 / 直接数组输入） */
export interface RawMessage {
  role?: MessageRole | string;
  text: string;
  ts?: number | string | null;
  meta?: Record<string, unknown>;
}

/* ================================================================
 * 二、结构化选项与结果
 * ===============================================================*/

export interface StructureOptions {
  /** 说话人名 → 角色映射（子串匹配：speakerName 含 alias 键即命中，取最长键） */
  roleAliases?: Record<string, MessageRole>;
  /** 无法判定角色时的缺省（默认 'unlabeled'） */
  defaultRole?: MessageRole;
  /** 无年份日期（MM-DD HH:MM:SS）的补全年份 */
  baseYear?: number;
  /** LLM provider（纯文本分角色用；缺省走降级路径） */
  provider?: LLMProviderLike;
  /** LLM 分角色的每批行数（默认 60） */
  llmBatchLines?: number;
}

/** LLM provider 最小面（完整抽象见 open/distill.ts，此处仅类型依赖） */
export interface LLMProviderLike {
  readonly name: string;
  chat(req: { system?: string; user: string; json?: boolean }): Promise<string>;
}

export interface StructureResult {
  messages: UnifiedMessage[];
  stats: {
    total: number;
    byRole: Record<string, number>;
    /** 保留原文待标的消息数（无 key 降级 / alias 未命中） */
    pendingLabel: number;
    /** LLM 辅助分角色的消息数 */
    llmAssisted: number;
  };
}

/* ================================================================
 * 三、L2 主入口
 * ===============================================================*/

/**
 * L2 结构化（async：纯文本路径可能走 LLM；其余路径零 LLM 零网络）。
 * 输入三形态：
 * - RawMessage[]（结构化源）→ 直映射
 * - Segment[]（L1 产物）→ header 确定性解析 + roleAliases
 * - string（纯文本）→ provider 分角色 / 无 key 降级按行 unlabeled
 */
export async function structureMessages(
  input: Segment[] | RawMessage[] | string,
  options: StructureOptions = {},
): Promise<StructureResult> {
  if (typeof input === 'string') return structurePlainText(input, options);
  if (input.length > 0 && isRawMessageArray(input)) return structureRaw(input, options);
  return structureSegments(input as Segment[], options);
}

/** 形态判别：有 text 字段且 header 不存在 → RawMessage[] */
function isRawMessageArray(input: Segment[] | RawMessage[]): boolean {
  const first = input[0] as Partial<Segment> & Partial<RawMessage>;
  return typeof first.text === 'string' && first.header === undefined;
}

/* ---------- 路径 1：结构化源直映射 ---------- */

function structureRaw(input: RawMessage[], options: StructureOptions): StructureResult {
  const defaultRole = options.defaultRole ?? 'unlabeled';
  const messages: UnifiedMessage[] = input.map((raw) => {
    const role = normalizeRole(raw.role) ?? defaultRole;
    const ts = parseTsValue(raw.ts);
    const meta: Record<string, unknown> = { ...raw.meta, source: 'structured' };
    if (raw.role !== undefined && normalizeRole(raw.role) === null) {
      meta.originalRole = raw.role; // 非标准角色值原样存证
    }
    return { ts, role, text: raw.text, meta };
  });
  return buildResult(messages, { pendingLabel: 0, llmAssisted: 0 });
}

/* ---------- 路径 2：L1 段（带消息头）确定性解析 ---------- */

function structureSegments(segments: Segment[], options: StructureOptions): StructureResult {
  const defaultRole = options.defaultRole ?? 'unlabeled';
  const baseYear = options.baseYear ?? new Date().getUTCFullYear();
  let pendingLabel = 0;
  const messages: UnifiedMessage[] = [];

  for (const segment of segments) {
    // 结构化源（ref 携带原始消息对象）：直映射复原 role/ts/meta，
    // text 用 L1 清洗后的版本（清洗只改写正文与段去留）
    const ref = segment.ref as Partial<RawMessage> | undefined;
    if (ref && typeof ref === 'object' && typeof ref.text === 'string') {
      const role = normalizeRole(ref.role) ?? defaultRole;
      const meta: Record<string, unknown> = { ...(ref.meta ?? {}), source: 'structured' };
      if (ref.role !== undefined && normalizeRole(ref.role) === null) meta.originalRole = ref.role;
      messages.push({
        ts: parseTsValue(ref.ts ?? null),
        role,
        text: segment.text,
        meta,
      });
      continue;
    }
    if (!segment.header) {
      // 无消息头的散文本段：保留原文待标
      pendingLabel++;
      messages.push({
        ts: null,
        role: defaultRole,
        text: segment.text,
        meta: { source: 'segment', pendingLabel: true },
      });
      continue;
    }
    const parsed = parseHeader(segment.header, baseYear);
    const alias = parsed ? matchAlias(parsed.speaker, options.roleAliases) : undefined;
    const role = alias?.role ?? defaultRole;
    if (!alias) pendingLabel++;
    const meta: Record<string, unknown> = {
      source: 'segment',
      ...(parsed ? { speaker: parsed.speaker } : {}),
      ...(parsed?.rawTime ? { rawTime: parsed.rawTime } : {}),
      ...(alias ? { roleMatched: alias.alias } : { pendingLabel: true }),
    };
    messages.push({ ts: parsed?.ts ?? null, role, text: segment.text, meta });
  }
  return buildResult(messages, { pendingLabel, llmAssisted: 0 });
}

/** 消息头解析（「名字: MM-DD HH:MM:SS」形） */
export function parseHeader(
  header: string,
  baseYear = new Date().getUTCFullYear(),
): { speaker: string; ts: number | null; rawTime: string } | null {
  const m = header.match(
    /^([^\s:：][^\s:：]{0,19})\s*[:：]\s*(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!m) return null;
  const [, speaker, mm, dd, hh, mi, ss] = m;
  const month = Number(mm);
  const day = Number(dd);
  const hour = Number(hh);
  const minute = Number(mi);
  const second = ss !== undefined ? Number(ss) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return { speaker, ts: null, rawTime: `${mm}-${dd} ${hh}:${mi}${ss ? `:${ss}` : ''}` };
  }
  const ts = Date.UTC(baseYear, month - 1, day, hour, minute, second);
  return { speaker, ts, rawTime: `${mm}-${dd} ${hh}:${mi}${ss ? `:${ss}` : ''}` };
}

/** alias 子串匹配（取最长命中键，防短别名抢先于长别名） */
function matchAlias(
  speaker: string,
  roleAliases?: Record<string, MessageRole>,
): { role: MessageRole; alias: string } | undefined {
  if (!roleAliases) return undefined;
  let best: { role: MessageRole; alias: string } | undefined;
  for (const [alias, role] of Object.entries(roleAliases)) {
    if (speaker.includes(alias) && (!best || alias.length > best.alias.length)) {
      best = { role, alias };
    }
  }
  return best;
}

/* ---------- 路径 3：纯文本 → LLM 分角色 / 无 key 降级 ---------- */

/**
 * P0 转写模板（txt-docx 适配器复用；沉淀于此，36 施工案 36.2 拍板）。
 * 输出契约：JSON 数组 [{ "role": "user"|"assistant", "text": "..." }]。
 */
export const PROMPT_TRANSCRIBE_ROLES = {
  system:
    '你是聊天记录结构化助手。给定一段纯文本聊天记录，请把它拆分为消息序列，' +
    '并根据语气、称呼、对话回合判断每条消息的说话方角色（user = 记录主人，' +
    'assistant = AI 伴侣/对话对象）。只输出 JSON，不要输出任何其他文字。',
  user: (block: string) =>
    '请将下面的聊天记录拆分为消息并标注角色，输出 JSON 数组：' +
    '[{"role":"user"|"assistant","text":"消息原文"}]。保持原文不改写、不删减；' +
    '系统提示/旁白标为 {"role":"system","text":"..."}。无法判断的标 "unlabeled"。\n\n' +
    block,
};

async function structurePlainText(
  text: string,
  options: StructureOptions,
): Promise<StructureResult> {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return buildResult([], { pendingLabel: 0, llmAssisted: 0 });

  if (!options.provider) {
    // 无 key 降级：保留原文待标，不报错（36 施工案拍板）
    const messages: UnifiedMessage[] = lines.map((line) => ({
      ts: null,
      role: 'unlabeled' as const,
      text: line,
      meta: { source: 'plaintext', pendingLabel: true },
    }));
    return buildResult(messages, { pendingLabel: messages.length, llmAssisted: 0 });
  }

  // LLM 分角色（分批）
  const batchSize = options.llmBatchLines ?? 60;
  const messages: UnifiedMessage[] = [];
  for (let base = 0; base < lines.length; base += batchSize) {
    const block = lines.slice(base, base + batchSize).join('\n');
    const raw = await options.provider.chat({
      system: PROMPT_TRANSCRIBE_ROLES.system,
      user: PROMPT_TRANSCRIBE_ROLES.user(block),
      json: true,
    });
    let batchMessages: UnifiedMessage[] | null = null;
    try {
      const parsed = JSON.parse(extractJsonText(raw)) as Array<{
        role?: string;
        text?: string;
      }>;
      if (Array.isArray(parsed)) {
        batchMessages = parsed
          .filter((item) => typeof item?.text === 'string' && item.text.length > 0)
          .map((item) => ({
            ts: null,
            role: normalizeRole(item.role) ?? 'unlabeled',
            text: item.text as string,
            meta: { source: 'plaintext', llmRoleLabel: true, lineBatch: Math.floor(base / batchSize) },
          }));
      }
    } catch {
      batchMessages = null;
    }
    if (!batchMessages) {
      // LLM 输出不可解析 → 本批降级保留原文待标（不报错）
      for (const line of lines.slice(base, base + batchSize)) {
        messages.push({
          ts: null,
          role: 'unlabeled',
          text: line,
          meta: { source: 'plaintext', pendingLabel: true, lineBatch: Math.floor(base / batchSize) },
        });
      }
      continue;
    }
    messages.push(...batchMessages);
  }
  const llmAssisted = messages.filter((m) => m.meta?.llmRoleLabel === true).length;
  const pendingLabel = messages.filter((m) => m.meta?.pendingLabel === true).length;
  return buildResult(messages, { pendingLabel, llmAssisted });
}

/** JSON 文本提取（与 clean.ts 同规则；此处独立实现保持模块自包含零依赖） */
function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const first = trimmed.search(/[[{]/);
  if (first < 0) return trimmed;
  const lastObj = trimmed.lastIndexOf('}');
  const lastArr = trimmed.lastIndexOf(']');
  const last = Math.max(lastObj, lastArr);
  return last > first ? trimmed.slice(first, last + 1) : trimmed;
}

/* ================================================================
 * 四、内部工具
 * ===============================================================*/

function normalizeRole(role?: string): MessageRole | null {
  if (role === 'user' || role === 'assistant' || role === 'system' || role === 'unlabeled') {
    return role;
  }
  return null;
}

/** ts 值解析：number 直用；ISO 字符串/「MM-DD HH:MM:SS」串解析；其余 null */
function parseTsValue(ts: number | string | null | undefined): number | null {
  if (ts === null || ts === undefined) return null;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  const asNum = Number(ts);
  if (Number.isFinite(asNum) && /^\d+$/.test(ts.trim())) return asNum;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? null : parsed;
}

function buildResult(
  messages: UnifiedMessage[],
  extra: { pendingLabel: number; llmAssisted: number },
): StructureResult {
  const byRole: Record<string, number> = {};
  for (const m of messages) byRole[m.role] = (byRole[m.role] ?? 0) + 1;
  return {
    messages,
    stats: { total: messages.length, byRole, ...extra },
  };
}
