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
import { cleanSegments, llmRedactReview, mergeCleanConfig, loadCleanConfig, } from './clean.js';
import { structureMessages, } from './structure.js';
import { distill, createProviderFromEnv, skippedDistill, } from './distill.js';
import { exportMemPack, writeMemPackFiles, } from './mempack.js';
/* ================================================================
 * 二、lite 主流程
 * ===============================================================*/
/** lite 总装入口（异步：LLM 分支；无 provider 时全程纯本地） */
export async function runLitePipeline(options) {
    const now = options.now ?? Date.now;
    const degradationReasons = [];
    // 0) provider 解析
    let provider;
    if (options.provider === 'env') {
        provider = createProviderFromEnv();
    }
    else if (options.provider) {
        provider = options.provider;
    }
    else {
        provider = undefined;
    }
    if (!provider)
        degradationReasons.push('no_llm_provider');
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
    let distillResult;
    if (options.withDistill !== false && provider) {
        distillResult = await distill(structured.messages, { provider, now });
    }
    else {
        distillResult = skippedDistill(now);
        if (options.withDistill !== false && !provider) {
            distillResult = { ...distillResult, skipReason: 'no_provider' };
        }
        else if (options.withDistill === false) {
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
    let files;
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
function resolveConfig(config) {
    if (typeof config === 'string')
        return loadCleanConfig(config);
    return mergeCleanConfig(config);
}
/* ================================================================
 * 三、便捷再导出（lite 用户只需 import 本文件）
 * ===============================================================*/
export { cleanSegments, llmRedactReview, loadCleanConfig, mergeCleanConfig, DEFAULT_CLEAN_CONFIG, } from './clean.js';
export { structureMessages, } from './structure.js';
export { distill, distillWeek, distillLayers, createProviderFromEnv, OpenAICompatibleProvider, skippedDistill, PROMPTS, groupByWeek, } from './distill.js';
export { exportMemPack, exportWakeupMemJsonl, exportMessagesJsonl, exportMarkdown, writeMemPackFiles, mempackStats, MEMPACK_SCHEMA_VERSION, MEMPACK_GENERATOR, } from './mempack.js';
