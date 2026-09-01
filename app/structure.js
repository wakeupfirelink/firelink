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
export async function structureMessages(input, options = {}) {
    if (typeof input === 'string')
        return structurePlainText(input, options);
    if (input.length > 0 && isRawMessageArray(input))
        return structureRaw(input, options);
    return structureSegments(input, options);
}
/** 形态判别：有 text 字段且 header 不存在 → RawMessage[] */
function isRawMessageArray(input) {
    const first = input[0];
    return typeof first.text === 'string' && first.header === undefined;
}
/* ---------- 路径 1：结构化源直映射 ---------- */
function structureRaw(input, options) {
    const defaultRole = options.defaultRole ?? 'unlabeled';
    const messages = input.map((raw) => {
        const role = normalizeRole(raw.role) ?? defaultRole;
        const ts = parseTsValue(raw.ts);
        const meta = { ...raw.meta, source: 'structured' };
        if (raw.role !== undefined && normalizeRole(raw.role) === null) {
            meta.originalRole = raw.role; // 非标准角色值原样存证
        }
        return { ts, role, text: raw.text, meta };
    });
    return buildResult(messages, { pendingLabel: 0, llmAssisted: 0 });
}
/* ---------- 路径 2：L1 段（带消息头）确定性解析 ---------- */
function structureSegments(segments, options) {
    const defaultRole = options.defaultRole ?? 'unlabeled';
    const baseYear = options.baseYear ?? new Date().getUTCFullYear();
    let pendingLabel = 0;
    const messages = [];
    for (const segment of segments) {
        // 结构化源（ref 携带原始消息对象）：直映射复原 role/ts/meta，
        // text 用 L1 清洗后的版本（清洗只改写正文与段去留）
        const ref = segment.ref;
        if (ref && typeof ref === 'object' && typeof ref.text === 'string') {
            const role = normalizeRole(ref.role) ?? defaultRole;
            const meta = { ...(ref.meta ?? {}), source: 'structured' };
            if (ref.role !== undefined && normalizeRole(ref.role) === null)
                meta.originalRole = ref.role;
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
        if (!alias)
            pendingLabel++;
        const meta = {
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
export function parseHeader(header, baseYear = new Date().getUTCFullYear()) {
    const m = header.match(/^([^\s:：][^\s:：]{0,19})\s*[:：]\s*(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m)
        return null;
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
function matchAlias(speaker, roleAliases) {
    if (!roleAliases)
        return undefined;
    let best;
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
    system: '你是聊天记录结构化助手。给定一段纯文本聊天记录，请把它拆分为消息序列，' +
        '并根据语气、称呼、对话回合判断每条消息的说话方角色（user = 记录主人，' +
        'assistant = AI 伴侣/对话对象）。只输出 JSON，不要输出任何其他文字。',
    user: (block) => '请将下面的聊天记录拆分为消息并标注角色，输出 JSON 数组：' +
        '[{"role":"user"|"assistant","text":"消息原文"}]。保持原文不改写、不删减；' +
        '系统提示/旁白标为 {"role":"system","text":"..."}。无法判断的标 "unlabeled"。\n\n' +
        block,
};
async function structurePlainText(text, options) {
    const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    if (lines.length === 0)
        return buildResult([], { pendingLabel: 0, llmAssisted: 0 });
    if (!options.provider) {
        // 无 key 降级：保留原文待标，不报错（36 施工案拍板）
        const messages = lines.map((line) => ({
            ts: null,
            role: 'unlabeled',
            text: line,
            meta: { source: 'plaintext', pendingLabel: true },
        }));
        return buildResult(messages, { pendingLabel: messages.length, llmAssisted: 0 });
    }
    // LLM 分角色（分批）
    const batchSize = options.llmBatchLines ?? 60;
    const messages = [];
    for (let base = 0; base < lines.length; base += batchSize) {
        const block = lines.slice(base, base + batchSize).join('\n');
        const raw = await options.provider.chat({
            system: PROMPT_TRANSCRIBE_ROLES.system,
            user: PROMPT_TRANSCRIBE_ROLES.user(block),
            json: true,
        });
        let batchMessages = null;
        try {
            const parsed = JSON.parse(extractJsonText(raw));
            if (Array.isArray(parsed)) {
                batchMessages = parsed
                    .filter((item) => typeof item?.text === 'string' && item.text.length > 0)
                    .map((item) => ({
                    ts: null,
                    role: normalizeRole(item.role) ?? 'unlabeled',
                    text: item.text,
                    meta: { source: 'plaintext', llmRoleLabel: true, lineBatch: Math.floor(base / batchSize) },
                }));
            }
        }
        catch {
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
function extractJsonText(text) {
    const trimmed = text.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced)
        return fenced[1].trim();
    const first = trimmed.search(/[[{]/);
    if (first < 0)
        return trimmed;
    const lastObj = trimmed.lastIndexOf('}');
    const lastArr = trimmed.lastIndexOf(']');
    const last = Math.max(lastObj, lastArr);
    return last > first ? trimmed.slice(first, last + 1) : trimmed;
}
/* ================================================================
 * 四、内部工具
 * ===============================================================*/
function normalizeRole(role) {
    if (role === 'user' || role === 'assistant' || role === 'system' || role === 'unlabeled') {
        return role;
    }
    return null;
}
/** ts 值解析：number 直用；ISO 字符串/「MM-DD HH:MM:SS」串解析；其余 null */
function parseTsValue(ts) {
    if (ts === null || ts === undefined)
        return null;
    if (typeof ts === 'number')
        return Number.isFinite(ts) ? ts : null;
    const asNum = Number(ts);
    if (Number.isFinite(asNum) && /^\d+$/.test(ts.trim()))
        return asNum;
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? null : parsed;
}
function buildResult(messages, extra) {
    const byRole = {};
    for (const m of messages)
        byRole[m.role] = (byRole[m.role] ?? 0) + 1;
    return {
        messages,
        stats: { total: messages.length, byRole, ...extra },
    };
}
