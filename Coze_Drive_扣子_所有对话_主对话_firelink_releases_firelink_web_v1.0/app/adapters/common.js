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
import { firelinkIO } from '../io-impl.js';
import { DEFAULT_MESSAGE_BOUNDARY } from '../clean.js';
import { structureMessages, } from '../structure.js';
/* ================================================================
 * 三、输入形态判别与读取
 * ===============================================================*/
export function isBytesInput(x) {
    return x instanceof Uint8Array;
}
export function isPathInput(x) {
    if (typeof x !== 'object' || x === null || Array.isArray(x) || x instanceof Uint8Array) {
        return false;
    }
    const rec = x;
    return rec.kind === 'path' && typeof rec.path === 'string';
}
export function isFilesInput(x) {
    if (typeof x !== 'object' || x === null || Array.isArray(x) || x instanceof Uint8Array) {
        return false;
    }
    const rec = x;
    return rec.kind === 'files' && typeof rec.files === 'object' && rec.files !== null;
}
export async function readPathBytes(path) {
    return await firelinkIO.readFileBytes(path);
}
export async function readPathText(path) {
    return await firelinkIO.readFileText(path);
}
export function decodeUtf8(data) {
    return new TextDecoder('utf-8').decode(data);
}
/**
 * 文本类输入统一解析为字符串：
 * string 直用；path 读文件；bytes 按 utf-8 解码；已解析对象序列化回文本
 */
export async function resolveInputText(input, adapterName) {
    if (typeof input === 'string')
        return input;
    if (isPathInput(input))
        return await readPathText(input.path);
    if (isBytesInput(input))
        return decodeUtf8(input);
    if (isFilesInput(input)) {
        throw new Error(`${adapterName} 适配器：不支持的输入形态 files（期待单文件文本内容或路径）`);
    }
    return JSON.stringify(input);
}
/** 宽容 JSON 解析（剥 BOM；失败返回 undefined） */
export function tryParseJson(text) {
    try {
        return JSON.parse(text.replace(/^\uFEFF/, '').trim());
    }
    catch {
        return undefined;
    }
}
/* ================================================================
 * 四、时间解析工具
 * ===============================================================*/
/** ISO 8601 时间串 → epoch ms；非法返回 null */
export function parseIsoTs(value) {
    if (typeof value !== 'string')
        return null;
    const t = value.trim();
    if (t.length === 0)
        return null;
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? null : ms;
}
/** epoch 秒/毫秒数值（number 或数字串）→ epoch ms；非法返回 null */
export function epochToMs(value) {
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0)
            return null;
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
export function buildL0Result(messages, extra = {}) {
    const byRole = {};
    for (const m of messages) {
        const key = m.role ?? 'unlabeled';
        byRole[key] = (byRole[key] ?? 0) + 1;
    }
    return {
        messages,
        stats: {
            total: messages.length,
            byRole,
            pendingLabel: extra.pendingLabel ?? messages.filter((m) => m.meta?.pendingLabel === true).length,
            llmAssisted: extra.llmAssisted ?? messages.filter((m) => m.meta?.llmRoleLabel === true).length,
            skipped: extra.skipped ?? 0,
        },
        meta: extra.meta ?? {},
    };
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
export async function structureChatText(text, options = {}) {
    const nonEmptyLines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const matches = [...text.matchAll(new RegExp(DEFAULT_MESSAGE_BOUNDARY.pattern, 'g'))];
    const ratio = matches.length / Math.max(1, nonEmptyLines.length);
    let headerMode;
    if (options.mode === 'headers')
        headerMode = true;
    else if (options.mode === 'plaintext')
        headerMode = false;
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
function splitHeaderSegments(text, matches) {
    const segments = [];
    const leading = text.slice(0, matches[0].index ?? 0).trim();
    if (leading.length > 0)
        segments.push({ header: null, text: leading });
    for (let i = 0; i < matches.length; i++) {
        const start = (matches[i].index ?? 0) + matches[i][0].length;
        const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
        const body = text.slice(start, end).trim();
        if (body.length === 0)
            continue; // 空正文消息不值得入记忆
        segments.push({ header: matches[i][0].trim(), text: body });
    }
    return segments;
}
/* ================================================================
 * 七、LLM 输出 JSON 提取（与 structure.ts 同规则；独立实现保持自包含）
 * ===============================================================*/
/** 从 LLM 输出中提取 JSON 数组（剥代码围栏 / 前后噪声）；失败返回 null */
export function extractJsonArrayFromText(text) {
    const trimmed = text.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1].trim() : trimmed;
    const first = candidate.search(/[[{]/);
    if (first < 0)
        return null;
    const lastArr = candidate.lastIndexOf(']');
    const lastObj = candidate.lastIndexOf('}');
    const last = Math.max(lastArr, lastObj);
    const sliced = last > first ? candidate.slice(first, last + 1) : candidate;
    try {
        const parsed = JSON.parse(sliced);
        if (Array.isArray(parsed))
            return parsed;
        return null;
    }
    catch {
        return null;
    }
}
