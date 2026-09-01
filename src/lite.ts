/*
 * 传火（firelink）· 开源记忆加工内核 · lite 总装
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
 * lite 总装：clean → structure →（distill 可选）→ mempack
 * ---------------------------------------------------------------
 * 36 施工案 36.1 拍板：lite 零外部依赖可跑（纯本地 BYO key、零上传零遥测）。
 * - 无 key 全链自动降级：L3 跳过、纯文本保留原文待标、正则脱敏照常，
 *   产出纯结构化记忆包三格式，全程不报错
 * - 有 key（provider 注入或环境变量）时：纯文本 LLM 分角色 + L3 提纯 + LLM 脱敏复核（可选）
 * - 不含 L4 入库（入库是闭源编排层的事；lite 是开源子集的最外沿）
 */

import {
  cleanSegments,
  llmRedactReview,
  mergeCleanConfig,
  loadCleanConfig,
  type CleanConfig,
  type CleanResult,
} from './clean.js';
import {
  structureMessages,
  type RawMessage,
  type StructureOptions,
  type UnifiedMessage,
} from './structure.js';
import {
  distill,
  createProviderFromEnv,
  skippedDistill,
  type DistillResult,
  type LLMProvider,
} from './distill.js';
import {
  exportMemPack,
  writeMemPackFiles,
  type MemPackBundle,
  type MemPackFiles,
} from './mempack.js';

/* ================================================================
 * 一、lite 选项与结果
 * ===============================================================*/

export interface LiteOptions {
  /** 原始输入：纯文本 / 已切分行 / 结构化消息数组 */
  input: string | string[] | RawMessage[];
  /** 清洗配置：对象 / JSON 文件路径 / 缺省默认 */
  config?: CleanConfig | Partial<CleanConfig> | string;
  /** LLM provider：显式实例 / 'env'（环境变量探测）/ 缺省无 LLM（降级路径） */
  provider?: LLMProvider | 'env';
  /** 是否跑 L3 提纯（默认 true；无 provider 时自动跳过） */
  withDistill?: boolean;
  /** LLM 脱敏复核层（默认关；需 provider） */
  llmRedactReview?: boolean;
  /** L2 结构化选项（roleAliases / baseYear 等；provider 由本层注入） */
  structure?: Omit<StructureOptions, 'provider'>;
  /** mempack 标题 */
  title?: string;
  /** 输出目录（提供则三格式落盘） */
  outputDir?: string;
  /** 落盘文件名前缀（默认 'mempack'） */
  filePrefix?: string;
  now?: () => number;
}

export interface LiteResult {
  clean: CleanResult;
  messages: UnifiedMessage[];
  distill: DistillResult;
  mempack: MemPackBundle & { files?: MemPackFiles['files'] };
  /** 降级标记（true = 本次运行无 LLM，纯本地链路） */
  degraded: boolean;
  degradationReasons: string[];
}

/* ================================================================
 * 二、lite 主流程
 * ===============================================================*/

/** lite 总装入口（异步：LLM 分支；无 provider 时全程纯本地） */
export async function runLitePipeline(options: LiteOptions): Promise<LiteResult> {
  const now = options.now ?? Date.now;
  const degradationReasons: string[] = [];

  // 0) provider 解析
  let provider: LLMProvider | undefined;
  if (options.provider === 'env') {
    provider = createProviderFromEnv();
  } else if (options.provider) {
    provider = options.provider;
  } else {
    provider = undefined;
  }
  if (!provider) degradationReasons.push('no_llm_provider');

  // 1) L1 清洗（噪音 + 重复段去重 + 正则脱敏）
  const config = resolveConfig(options.config);
  const clean = cleanSegments(options.input, config);

  // 1.5) LLM 脱敏复核（可选；无 provider 自动跳过）
  let segments = clean.segments;
  if (options.llmRedactReview && provider) {
    const reviewed = await llmRedactReview(segments, provider);
    segments = reviewed.segments;
  }

  // 2) L2 结构化（结构化源直映射 / 段头解析 / 纯文本 LLM 分角色或降级）
  const structured = await structureMessages(segments, {
    ...options.structure,
    ...(provider ? { provider } : {}),
  });

  // 3) L3 提纯（可选；无 provider 自动跳过，不报错）
  let distillResult: DistillResult;
  if (options.withDistill !== false && provider) {
    distillResult = await distill(structured.messages, { provider, now });
  } else {
    distillResult = skippedDistill(now);
    if (options.withDistill !== false && !provider) {
      distillResult = { ...distillResult, skipReason: 'no_provider' };
    } else if (options.withDistill === false) {
      distillResult = { ...distillResult, skipReason: 'disabled' };
    }
  }

  // 4) mempack 三格式导出（可选落盘）
  const createdAt = new Date(now()).toISOString();
  const bundle = exportMemPack(structured.messages, {
    title: options.title,
    createdAt,
    ...(typeof options.input === 'string' ? { source: 'plaintext' } : {}),
  });
  let files: MemPackFiles['files'] | undefined;
  if (options.outputDir) {
    files = writeMemPackFiles(options.outputDir, structured.messages, {
      title: options.title,
      createdAt,
      prefix: options.filePrefix ?? 'mempack',
    }).files;
  }

  return {
    clean,
    messages: structured.messages,
    distill: distillResult,
    mempack: { ...bundle, ...(files ? { files } : {}) },
    degraded: !provider,
    degradationReasons,
  };
}

/** 配置解析：路径 → loadCleanConfig；对象 → mergeCleanConfig；缺省 → 默认 */
function resolveConfig(
  config: CleanConfig | Partial<CleanConfig> | string | undefined,
): CleanConfig {
  if (typeof config === 'string') return loadCleanConfig(config);
  return mergeCleanConfig(config as Partial<CleanConfig> | undefined);
}

/* ================================================================
 * 三、便捷再导出（lite 用户只需 import 本文件）
 * ===============================================================*/

export {
  cleanSegments,
  llmRedactReview,
  loadCleanConfig,
  mergeCleanConfig,
  DEFAULT_CLEAN_CONFIG,
  type CleanConfig,
  type CleanResult,
  type Segment,
} from './clean.js';
export {
  structureMessages,
  type MessageRole,
  type RawMessage,
  type StructureOptions,
  type StructureResult,
  type UnifiedMessage,
} from './structure.js';
export {
  distill,
  distillWeek,
  distillLayers,
  createProviderFromEnv,
  OpenAICompatibleProvider,
  skippedDistill,
  PROMPTS,
  groupByWeek,
  type DistillResult,
  type DistillOptions,
  type LLMProvider,
  type WeeklySummary,
  type Anchor,
  type LongTermItem,
  type NotebookItem,
  type ProfileSignal,
} from './distill.js';
export {
  exportMemPack,
  exportWakeupMemJsonl,
  exportMessagesJsonl,
  exportMarkdown,
  writeMemPackFiles,
  mempackStats,
  MEMPACK_SCHEMA_VERSION,
  MEMPACK_GENERATOR,
  type MemPackBundle,
  type MemPackFiles,
  type MemPackMeta,
  type MemPackOptions,
} from './mempack.js';
