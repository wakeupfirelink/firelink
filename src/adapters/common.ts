/*
 * 传火（firelink）· 开源记忆加工内核 · L0 适配器层 · 公共接口
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
 * L0 适配器层公共接口（36 施工案 36.2）
 * ---------------------------------------------------------------
 * 统一适配器契约：
 * - 输入：原始导出内容（文本 / 二进制 / 本地路径 / 多文件映射）
 * - 输出：统一 schema 消息（对齐 open/structure.ts 的 RawMessage 形），
 *   可直接作为 runLitePipeline({ input: messages }) 的输入——
 *   L1 清洗（ref 保真切段）→ L2 直映射（保留 role/ts/meta）
 * - 适配器不做 L1 职责内的事（噪音过滤 / 去重 / 脱敏留给 L1）
 * - LLM 步骤复用 36.1 已有的 provider 抽象（open/structure.ts LLMProviderLike），
 *   不重复造；无 key 走降级路径（保留原文待标注，不报错）
 */

import { readFile } from 'node:fs/promises';
import { DEFAULT_MESSAGE_BOUNDARY, type Segment } from '../clean.js';
import {
  structureMessages,
  type LLMProviderLike,
  type MessageRole,
  type RawMessage,
} from '../structure.js';

/* ================================================================
 * 一、输入 / 选项 / 结果类型
 * ===============================================================*/

/** 本地文件路径输入（适配器自行读取，按扩展名分派） */
export interface L0PathInput {
  kind: 'path';
  path: string;
}

/** 多文件映射输入（如三文件导出：文件名 → 文本内容 / 字节 / 已解析对象） */
export interface L0FileInput {
  kind: 'files';
  files: Record<string, string | Uint8Array | Record<string, unknown> | unknown[]>;
}

/**
 * L0 统一输入：
 * - string：原始文本内容（JSON / JSONL / HTML / 纯文本）
 * - Record<string, unknown>：已解析的 JSON 对象
 * - Uint8Array：原始二进制（ZIP / DOCX / 图片）
 * - L0PathInput / L0FileInput：路径 / 多文件形态
 */
export type L0Input = string | Record<string, unknown> | Uint8Array | L0PathInput | L0FileInput;

/** L0 适配器选项（各适配器按需取用） */
export interface L0Options {
  /** 说话人名 → 角色映射（段头模式：子串匹配，取最长命中键） */
  roleAliases?: Record<string, MessageRole>;
  /** 无年份日期（MM-DD HH:MM:SS）的补全年份 */
  baseYear?: number;
  /** 文本分角色 LLM provider（BYO key；缺省走降级路径保留原文待标注） */
  provider?: LLMProviderLike;
  /** 段头模式判定阈值：命中边界数 / 非空行数 ≥ 该值才走段头解析（默认 0.2） */
  headerRatio?: number;
  /** 强制解析模式（缺省 auto：自动判定） */
  mode?: 'auto' | 'headers' | 'plaintext';
  /** 多模态 provider（screenshot 适配器必填，BYO key） */
  multimodal?: MultimodalProvider;
  /** chatgpt 适配器：消息树遍历模式（tree=全树 DFS；current-path=仅当前主路径） */
  chatgptMode?: 'tree' | 'current-path';
}

/** L0 结果统计 */
export interface L0Stats {
  total: number;
  byRole: Record<string, number>;
  /** 保留原文待标注的消息数 */
  pendingLabel: number;
  /** LLM 辅助标注的消息数 */
  llmAssisted: number;
  /** 跳过的原始条目（空消息 / 工具消息 / 解析失败行等） */
  skipped: number;
}

/** L0 适配器结果：统一 schema 消息 + 统计 + 来源摘要 */
export interface L0Result {
  messages: RawMessage[];
  stats: L0Stats;
  meta: Record<string, unknown>;
}

/** 适配器实现状态（接入位适配器为 not-implemented） */
export type L0AdapterStatus = 'ready' | 'not-implemented';

/** 统一适配器接口（36 施工案 36.2：输入原始内容 → 输出统一 schema） */
export interface L0Adapter {
  /** 注册名（注册表键，如 'chatgpt'） */
  readonly name: string;
  /** 人类可读名 */
  readonly label: string;
  /** 输入格式说明 */
  readonly description: string;
  /** 实现状态（缺省 ready） */
  readonly status?: L0AdapterStatus;
  convert(input: L0Input, options?: L0Options): Promise<L0Result>;
}

/* ---------- 多模态 provider 抽象（screenshot 适配器用，BYO key 可插拔） ---------- */

export interface MultimodalTranscribeRequest {
  image: Uint8Array;
  mimeType: string;
  prompt: string;
}

/** 多模态转写 provider 最小面（实现此接口即可插拔：任意视觉端点 / mock） */
export interface MultimodalProvider {
  readonly name: string;
  transcribe(req: MultimodalTranscribeRequest): Promise<string>;
}

/* ================================================================
 * 二、类型再导出（适配器用户只需 import common）
 * ===============================================================*/

export type { RawMessage, MessageRole, LLMProviderLike } from '../structure.js';

/* ================================================================
 * 三、输入形态判别与读取
 * ===============================================================*/

export function isBytesInput(x: unknown): x is Uint8Array {
  return x instanceof Uint8Array;
}

export function isPathInput(x: unknown): x is L0PathInput {
  if (typeof x !== 'object' || x === null || Array.isArray(x) || x instanceof Uint8Array) {
    return false;
  }
  const rec = x as { kind?: unknown; path?: unknown };
  return rec.kind === 'path' && typeof rec.path === 'string';
}

export function isFilesInput(x: unknown): x is L0FileInput {
  if (typeof x !== 'object' || x === null || Array.isArray(x) || x instanceof Uint8Array) {
    return false;
  }
  const rec = x as { kind?: unknown; files?: unknown };
  return rec.kind === 'files' && typeof rec.files === 'object' && rec.files !== null;
}

export async function readPathBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

export async function readPathText(path: string): Promise<string> {
  return await readFile(path, 'utf-8');
}

export function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder('utf-8').decode(data);
}

/**
 * 文本类输入统一解析为字符串：
 * string 直用；path 读文件；bytes 按 utf-8 解码；已解析对象序列化回文本
 */
export async function resolveInputText(input: L0Input, adapterName: string): Promise<string> {
  if (typeof input === 'string') return input;
  if (isPathInput(input)) return await readPathText(input.path);
  if (isBytesInput(input)) return decodeUtf8(input);
  if (isFilesInput(input)) {
    throw new Error(`${adapterName} 适配器：不支持的输入形态 files（期待单文件文本内容或路径）`);
  }
  return JSON.stringify(input);
}

/** 宽容 JSON 解析（剥 BOM；失败返回 undefined） */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '').trim());
  } catch {
    return undefined;
  }
}

/* ================================================================
 * 四、时间解析工具
 * ===============================================================*/

/** ISO 8601 时间串 → epoch ms；非法返回 null */
export function parseIsoTs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t.length === 0) return null;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

/** epoch 秒/毫秒数值（number 或数字串）→ epoch ms；非法返回 null */
export function epochToMs(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) {
    return epochToMs(Number(value.trim()));
  }
  return null;
}

/* ================================================================
 * 五、结果构造
 * ===============================================================*/

/** 构造 L0Result（pendingLabel/llmAssisted 缺省按 meta 标志自动统计） */
export function buildL0Result(
  messages: RawMessage[],
  extra: {
    pendingLabel?: number;
    llmAssisted?: number;
    skipped?: number;
    meta?: Record<string, unknown>;
  } = {},
): L0Result {
  const byRole: Record<string, number> = {};
  for (const m of messages) {
    const key = m.role ?? 'unlabeled';
    byRole[key] = (byRole[key] ?? 0) + 1;
  }
  return {
    messages,
    stats: {
      total: messages.length,
      byRole,
      pendingLabel:
        extra.pendingLabel ?? messages.filter((m) => m.meta?.pendingLabel === true).length,
      llmAssisted:
        extra.llmAssisted ?? messages.filter((m) => m.meta?.llmRoleLabel === true).length,
      skipped: extra.skipped ?? 0,
    },
    meta: extra.meta ?? {},
  };
}

/* ================================================================
 * 六、聊天文本结构化（txt-docx / local-web 共用）
 * ================================================================*/

export interface ChatTextStructureOutcome {
  messages: RawMessage[];
  mode: 'headers' | 'plaintext';
  boundaryCount: number;
  pendingLabel: number;
  llmAssisted: number;
}

/** 段头模式默认判定阈值（命中边界数 / 非空行数） */
const HEADER_RATIO_DEFAULT = 0.2;

/**
 * 聊天文本 → 统一 schema：
 * - 段头模式（「名字: MM-DD HH:MM:SS 正文」等 docx 导出惯例）：按
 *   open/clean.ts 默认消息边界切段 → 复用 structure.ts 段头解析
 *   （说话人 + 时间 + roleAliases 子串匹配），零 LLM
 * - 纯文本模式：复用 structure.ts 纯文本路径（provider LLM 分角色 /
 *   无 key 降级按行保留原文待标注，不报错）
 */
export async function structureChatText(
  text: string,
  options: L0Options = {},
): Promise<ChatTextStructureOutcome> {
  const nonEmptyLines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const matches = [...text.matchAll(new RegExp(DEFAULT_MESSAGE_BOUNDARY.pattern, 'g'))];
  const ratio = matches.length / Math.max(1, nonEmptyLines.length);

  let headerMode: boolean;
  if (options.mode === 'headers') headerMode = true;
  else if (options.mode === 'plaintext') headerMode = false;
  else {
    headerMode =
      (matches.length >= 2 && ratio >= (options.headerRatio ?? HEADER_RATIO_DEFAULT)) ||
      (matches.length === 1 && nonEmptyLines.length === 1);
  }

  if (headerMode) {
    const segments = splitHeaderSegments(text, matches);
    const r = await structureMessages(segments, {
      ...(options.roleAliases ? { roleAliases: options.roleAliases } : {}),
      ...(options.baseYear !== undefined ? { baseYear: options.baseYear } : {}),
    });
    return {
      messages: r.messages,
      mode: 'headers',
      boundaryCount: matches.length,
      pendingLabel: r.stats.pendingLabel,
      llmAssisted: r.stats.llmAssisted,
    };
  }

  const r = await structureMessages(text, {
    ...(options.provider ? { provider: options.provider } : {}),
  });
  return {
    messages: r.messages,
    mode: 'plaintext',
    boundaryCount: matches.length,
    pendingLabel: r.stats.pendingLabel,
    llmAssisted: r.stats.llmAssisted,
  };
}

/** 按消息边界切段（与 open/clean.ts splitByBoundary 同构；空正文段跳过） */
function splitHeaderSegments(text: string, matches: RegExpMatchArray[]): Segment[] {
  const segments: Segment[] = [];
  const leading = text.slice(0, matches[0].index ?? 0).trim();
  if (leading.length > 0) segments.push({ header: null, text: leading });
  for (let i = 0; i < matches.length; i++) {
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end =
      i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const body = text.slice(start, end).trim();
    if (body.length === 0) continue; // 空正文消息不值得入记忆
    segments.push({ header: matches[i][0].trim(), text: body });
  }
  return segments;
}

/* ================================================================
 * 七、LLM 输出 JSON 提取（与 structure.ts 同规则；独立实现保持自包含）
 * ===============================================================*/

/** 从 LLM 输出中提取 JSON 数组（剥代码围栏 / 前后噪声）；失败返回 null */
export function extractJsonArrayFromText(
  text: string,
): Array<{ role?: string; text?: string }> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const first = candidate.search(/[[{]/);
  if (first < 0) return null;
  const lastArr = candidate.lastIndexOf(']');
  const lastObj = candidate.lastIndexOf('}');
  const last = Math.max(lastArr, lastObj);
  const sliced = last > first ? candidate.slice(first, last + 1) : candidate;
  try {
    const parsed = JSON.parse(sliced) as unknown;
    if (Array.isArray(parsed)) return parsed as Array<{ role?: string; text?: string }>;
    return null;
  } catch {
    return null;
  }
}
