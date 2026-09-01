/*
 * 传火（firelink）· 开源记忆加工内核 · L1 清洗层
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
 * L1 清洗层：平台噪音过滤 · 重复段指纹去重 · 脱敏
 * ---------------------------------------------------------------
 * 职责（36 施工案 36.1）：
 * - 噪音表可配置（JSON 配置文件；默认内置含「钻石余额不足」等平台气泡样例）
 * - 重复段指纹去重：滑窗 + 哈希指纹（连续 N 条段整体重复才删，防误删自然短句）
 * - 脱敏 = 正则层（手机号 / 身份证 / 学号 / 证件号）+ LLM 复核层（可选，
 *   BYO key，无 key 只跑正则层，不报错）
 *
 * 内核无状态：每次调用输入原始数据 → 输出结果，不持有会话状态。
 * 幂等性：清洗输出再清洗一遍结果不变（正则命中已替换、重复段已删、
 * 噪音规则不含会误伤清洗后文本的模式）。
 */
import { firelinkIO } from './io-impl.js';
/* ================================================================
 * 二、默认配置（内置样例噪音表 + 默认脱敏正则层）
 * ===============================================================*/
/**
 * 默认噪音表（样例，可用 JSON 配置文件覆盖/扩充）。
 * 「钻石余额不足」等为某平台系统气泡（36 施工案点名的验收样例）；
 * 4G / 5G / 纯数字短串为 docx 解析碎片。
 */
export const DEFAULT_NOISE_RULES = [
    { type: 'contains', pattern: '钻石余额不足', label: 'platform_bubble' },
    { type: 'contains', pattern: '请充值后继续使用', label: 'platform_bubble' },
    { type: 'contains', pattern: '消息发送失败', label: 'platform_bubble' },
    { type: 'contains', pattern: '对方已下线', label: 'platform_bubble' },
    { type: 'contains', pattern: '网络连接已断开', label: 'platform_bubble' },
    { type: 'contains', pattern: '签到成功，获得', label: 'platform_bubble' },
    { type: 'exact', pattern: '4G', label: 'docx_fragment' },
    { type: 'exact', pattern: '5G', label: 'docx_fragment' },
    { type: 'exact', pattern: 'Wi-Fi', label: 'docx_fragment' },
    { type: 'exact', pattern: '正在输入…', label: 'platform_bubble' },
    { type: 'exact', pattern: '[系统消息]', label: 'system_notice' },
    { type: 'regex', pattern: '^\\d{1,3}$', flags: '', label: 'docx_fragment' },
];
/**
 * 默认脱敏正则层（手机号 / 身份证 / 学号·证件号）。
 * 顺序敏感：身份证（18/15 位）在前，手机号在后，防长号部分消费。
 */
export const DEFAULT_REDACTION_RULES = [
    {
        name: 'id_card_18',
        pattern: '(?<!\\d)\\d{6}(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx](?!\\d)',
        flags: 'g',
        replacement: '[已脱敏:身份证号]',
    },
    {
        name: 'id_card_15',
        pattern: '(?<!\\d)\\d{6}\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}(?!\\d)',
        flags: 'g',
        replacement: '[已脱敏:身份证号]',
    },
    {
        name: 'phone',
        pattern: '(?<!\\d)1[3-9]\\d{9}(?!\\d)',
        flags: 'g',
        replacement: '[已脱敏:手机号]',
    },
    {
        name: 'student_id',
        pattern: '(?:学号|学籍号|考号|工号|证件号码?|护照号)\\s*[:：]?\\s*[A-Za-z0-9-]{5,25}',
        flags: 'g',
        replacement: '[已脱敏:证件号]',
    },
];
/** 默认消息边界（docx 解析惯例：「名字: MM-DD HH:MM:SS 正文」内嵌长行） */
export const DEFAULT_MESSAGE_BOUNDARY = {
    pattern: '([^\\s:：][^\\s:：]{0,19})\\s*[:：]\\s*(\\d{1,2})-(\\d{1,2})\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s+',
    flags: 'g',
};
/** 默认配置整体 */
export const DEFAULT_CLEAN_CONFIG = {
    noiseRules: DEFAULT_NOISE_RULES,
    dedup: { enabled: true, windowSize: 5, minSegmentLength: 4 },
    redactionRules: DEFAULT_REDACTION_RULES,
    stripControlChars: true,
    messageBoundary: DEFAULT_MESSAGE_BOUNDARY,
};
/* ================================================================
 * 三、配置加载与合并
 * ===============================================================*/
/** 深合并用户部分配置到默认配置（浅规则数组整体替换） */
export function mergeCleanConfig(partial) {
    if (!partial)
        return structuredCloneConfig(DEFAULT_CLEAN_CONFIG);
    return {
        noiseRules: partial.noiseRules ?? DEFAULT_NOISE_RULES.slice(),
        dedup: { ...DEFAULT_CLEAN_CONFIG.dedup, ...(partial.dedup ?? {}) },
        redactionRules: partial.redactionRules ?? DEFAULT_REDACTION_RULES.slice(),
        stripControlChars: partial.stripControlChars ?? DEFAULT_CLEAN_CONFIG.stripControlChars,
        messageBoundary: partial.messageBoundary ?? DEFAULT_MESSAGE_BOUNDARY,
    };
}
/**
 * 从 JSON 配置文件加载清洗配置（可配置噪音表的落点）。
 * JSON 结构 = CleanConfig 的部分字段（Partial<CleanConfig> 序列化形），
 * 未提供的字段回落默认值。配置样例见同目录 config.sample.json。
 */
export function loadCleanConfig(path) {
    const raw = JSON.parse(firelinkIO.readTextFileSync(path));
    return mergeCleanConfig(raw);
}
function structuredCloneConfig(config) {
    return {
        noiseRules: config.noiseRules.map((r) => ({ ...r })),
        dedup: { ...config.dedup },
        redactionRules: config.redactionRules.map((r) => ({ ...r })),
        stripControlChars: config.stripControlChars,
        messageBoundary: config.messageBoundary ? { ...config.messageBoundary } : undefined,
    };
}
/**
 * 切分输入为段序列：
 * - {text} 对象数组（结构化源）：每对象一段（ref=原对象，供 L2 复原）
 * - string[]：调用方已切段，每元素一段（header=null）
 * - string + messageBoundary：按消息头正则全局切段（正文=两边界间文本；
 *   首个边界前的散文本作为独立无 header 段）
 * - string 无 messageBoundary：按行切段
 */
export function splitSegments(input, config) {
    if (Array.isArray(input)) {
        // 字符串行：行首命中消息头正则 → 切出 header（供 L2 解析说话人/时间）
        const boundaryRe = config.messageBoundary
            ? new RegExp(config.messageBoundary.pattern, (config.messageBoundary.flags ?? 'g').replace('g', ''))
            : null;
        const segments = [];
        for (const item of input) {
            if (typeof item !== 'string') {
                const t = String(item.text ?? '').trim();
                if (t.length > 0)
                    segments.push({ header: null, text: t, ref: item });
                continue;
            }
            const line = item.trim();
            if (line.length === 0)
                continue;
            const m = boundaryRe ? boundaryRe.exec(line) : null;
            if (m && m.index === 0 && m[0].length > 0) {
                segments.push({ header: m[0].trim(), text: line.slice(m[0].length).trim(), ref: undefined });
            }
            else {
                segments.push({ header: null, text: line, ref: undefined });
            }
        }
        return segments;
    }
    const text = config.stripControlChars ? stripControl(input) : input;
    if (config.messageBoundary) {
        return splitByBoundary(text, config.messageBoundary);
    }
    return text
        .split(/\r?\n/)
        .map((line) => ({ header: null, text: line.trim() }))
        .filter((s) => s.text.length > 0);
}
/** 按消息边界正则切段 */
function splitByBoundary(text, boundary) {
    const re = new RegExp(boundary.pattern, boundary.flags ?? 'g');
    const segments = [];
    const matches = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        matches.push(m);
        if (m[0].length === 0)
            re.lastIndex++; // 防零宽死循环
    }
    if (matches.length === 0) {
        // 无任何消息头 → 整体按行降级
        return text
            .split(/\r?\n/)
            .map((line) => ({ header: null, text: line.trim() }))
            .filter((s) => s.text.length > 0);
    }
    const leading = text.slice(0, matches[0].index).trim();
    if (leading.length > 0)
        segments.push({ header: null, text: leading });
    for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index + matches[i][0].length;
        const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
        const body = text.slice(start, end).trim();
        if (body.length === 0 && matches[i][1].trim().length === 0)
            continue;
        segments.push({ header: matches[i][0].trim(), text: body });
    }
    return segments;
}
/** 清理 Unicode 控制字符与零宽字符（docx 解析残留），保留 \n 与 \t */
function stripControl(text) {
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, '');
}
/** L1 清洗（纯本地、同步、无 LLM；结构化源输入保留 ref 供 L2 复原） */
export function cleanSegments(input, config) {
    const cfg = isCleanConfig(config) ? config : mergeCleanConfig(config);
    const raw = splitSegments(input, cfg);
    const redactionHits = {};
    // 1) 噪音过滤
    const noNoise = raw.filter((s) => !isNoise(s, cfg));
    // 2) 重复段去重（滑窗指纹；短句豁免）
    const deduped = cfg.dedup.enabled
        ? dedupeSegments(noNoise, cfg.dedup.windowSize, cfg.dedup.minSegmentLength)
        : noNoise;
    // 3) 正则脱敏（仅作用段正文；header 由 L2 解析，ref 原样透传）
    const segments = deduped.map((s) => ({
        header: s.header,
        text: applyRedaction(s.text, cfg.redactionRules, redactionHits),
        ...(s.ref !== undefined ? { ref: s.ref } : {}),
    }));
    return {
        segments,
        stats: {
            inputCount: raw.length,
            outputCount: segments.length,
            noiseRemoved: raw.length - noNoise.length,
            dedupRemoved: noNoise.length - deduped.length,
            redactionHits,
        },
    };
}
/** Partial<CleanConfig> 与完整 CleanConfig 的判别（noiseRules 为完整配置标志位） */
function isCleanConfig(c) {
    return !!c && Array.isArray(c.noiseRules) && Array.isArray(c.redactionRules) && !!c.dedup;
}
/** 噪音判定 */
function isNoise(segment, config) {
    const text = segment.text.trim();
    if (text.length === 0)
        return true;
    for (const rule of config.noiseRules) {
        if (rule.type === 'exact' && text === rule.pattern)
            return true;
        if (rule.type === 'contains' && text.includes(rule.pattern))
            return true;
        if (rule.type === 'regex') {
            const re = new RegExp(rule.pattern, rule.flags ?? '');
            if (re.test(text))
                return true;
        }
    }
    return false;
}
/**
 * 重复段指纹去重（滑窗 + 哈希）：
 * - 指纹 = sha256(归一化正文) 前 16 hex；归一化 = 去全部空白（大小写不敏感）
 * - 滑窗 windowSize：窗口指纹序列（W 条连续指纹拼接）在历史中出现过 →
 *   该窗口整体标记为重复段（首现保留、再现删除）
 * - 窗口级判定保证「连续 W 条整体重复」才删——自然的短句重复（嗯/好）
 *   不构成连续窗口重复，不误删
 * - 与「整段文档两轮导出重复」的验收样本对齐：第二轮整段窗口全部命中
 */
export function dedupeSegments(segments, windowSize = 5, minSegmentLength = 4) {
    const n = segments.length;
    if (windowSize < 2 || n < windowSize * 2)
        return segments;
    const hashes = segments.map((s) => fingerprint(s.text));
    // 短句豁免：窗口内全部段都短于 minSegmentLength（嗯/好之类自然短句交替）
    // 时，该窗口不参与重复判定——去重语义目标是「大段重复导出」，不是短句复读
    const isShort = (i) => segments[i].text.trim().length < minSegmentLength;
    const removed = new Array(n).fill(false);
    const seen = new Set();
    for (let i = 0; i + windowSize <= n; i++) {
        let allShort = true;
        for (let j = i; j < i + windowSize; j++) {
            if (!isShort(j)) {
                allShort = false;
                break;
            }
        }
        if (allShort)
            continue;
        const key = hashes.slice(i, i + windowSize).join('|');
        if (seen.has(key)) {
            for (let j = i; j < i + windowSize; j++)
                removed[j] = true;
        }
        else {
            seen.add(key);
        }
    }
    return segments.filter((_, i) => !removed[i]);
}
/** 段指纹（归一化 + sha256 截断） */
export function fingerprint(text) {
    const normalized = text.replace(/\s+/g, '').toLowerCase();
    return firelinkIO.sha256Hex(normalized).slice(0, 16);
}
/** 正则脱敏：按规则顺序替换，命中计数写入 hits */
function applyRedaction(text, rules, hits) {
    let out = text;
    for (const rule of rules) {
        const re = new RegExp(rule.pattern, rule.flags ?? 'g');
        let count = 0;
        out = out.replace(re, () => {
            count++;
            return rule.replacement;
        });
        if (count > 0)
            hits[rule.name] = (hits[rule.name] ?? 0) + count;
    }
    return out;
}
/** LLM 复核提示词（内置模板） */
export const PROMPT_LLM_REDACT_REVIEW = {
    system: '你是数据脱敏复核器。你的任务是复查聊天记录片段，找出正则层可能漏掉的敏感信息' +
        '（真实姓名全名、住址、精确位置、账号名、银行卡号、其他证件号等），' +
        '并将该片段替换为脱敏后的版本（敏感部分替换为 [已脱敏:LLM复核]，其余原样保留）。' +
        '只输出 JSON，不要输出任何其他文字。',
    user: (indexedSegments) => '以下是编号片段（格式「#编号|内容」）：\n' +
        indexedSegments.join('\n') +
        '\n\n请复查并输出 JSON：{"hits":[{"index":编号,"text":"脱敏后全文"}]}。' +
        '若无任何片段需要脱敏，输出 {"hits":[]}。不要改动无敏感信息的片段。',
};
/**
 * LLM 复核层（可选）：对正则层清洗后的段做敏感信息复核。
 * - provider 缺失时原样返回（不报错，降级语义由调用方判定）
 * - 分批发送（默认每批 40 段），只替换 LLM 明确给出的段
 */
export async function llmRedactReview(segments, provider, options) {
    if (!provider || segments.length === 0) {
        return { segments, hits: [], stats: { batches: 0, replaced: 0 } };
    }
    const batchSize = options?.batchSize ?? 40;
    const out = segments.map((s) => ({ ...s }));
    const hits = [];
    let batches = 0;
    for (let base = 0; base < segments.length; base += batchSize) {
        const slice = segments.slice(base, base + batchSize);
        const indexed = slice.map((s, i) => `#${base + i}|${s.header ?? ''}${s.text}`);
        const raw = await provider.chat({
            system: PROMPT_LLM_REDACT_REVIEW.system,
            user: PROMPT_LLM_REDACT_REVIEW.user(indexed),
            json: true,
        });
        batches++;
        const parsed = extractJson(raw);
        if (!parsed || !Array.isArray(parsed.hits))
            continue;
        for (const hit of parsed.hits) {
            if (typeof hit?.index === 'number' &&
                hit.index >= base &&
                hit.index < base + batchSize &&
                typeof hit.text === 'string' &&
                hit.text.length > 0) {
                out[hit.index] = { ...out[hit.index], text: hit.text };
                hits.push({ index: hit.index, text: hit.text });
            }
        }
    }
    return { segments: out, hits, stats: { batches, replaced: hits.length } };
}
/** 容错 JSON 提取（直接 parse → ```json 围栏 → 首尾括号截取） */
export function extractJson(text) {
    const trimmed = text.trim();
    try {
        return JSON.parse(trimmed);
    }
    catch {
        /* 继续降级解析 */
    }
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
        try {
            return JSON.parse(fenced[1].trim());
        }
        catch {
            /* 继续降级解析 */
        }
    }
    const firstObj = trimmed.indexOf('{');
    const firstArr = trimmed.indexOf('[');
    const start = firstArr >= 0 && (firstArr < firstObj || firstObj < 0) ? firstArr : firstObj;
    if (start < 0)
        return null;
    const lastObj = trimmed.lastIndexOf('}');
    const lastArr = trimmed.lastIndexOf(']');
    const end = lastArr > lastObj ? lastArr : lastObj;
    if (end <= start)
        return null;
    try {
        return JSON.parse(trimmed.slice(start, end + 1));
    }
    catch {
        return null;
    }
}
