/*
 * 传火（firelink）· 开源记忆加工内核 · L3 提纯框架
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
 * L3 提纯框架：周摘要 · 锚点抽取 · 分层标签
 * ---------------------------------------------------------------
 * 三路泛化输出（36 施工案）：
 * - longTerm（长期记忆）→ L4 落长期记忆库
 * - notebook（笔记）    → L4 落笔记本库
 * - profile（画像信号） → L4 落用户画像库
 *
 * provider 抽象（可插拔，BYO key）：
 * - LLMProvider 接口 + OpenAICompatibleProvider（DeepSeek 默认 / 任意
 *   OpenAI 兼容端点；密钥环境变量注入；fetch 用 Node 18+ 内置实现）
 * - 无 key 自动降级：distill 返回 { skipped: true }，不报错
 *
 * 全部提示词模板内置开源（PROMPTS 导出）。
 * 内核无状态；LLM 调用分批（按自然周分组），批间独立可断点（断点编排在
 * 闭源编排层，本层提供单周入口 distillWeek）。
 */
import { firelinkIO } from './io-impl.js';
export class OpenAICompatibleProvider {
    name;
    model;
    opts;
    constructor(opts) {
        this.opts = opts;
        this.name = normalizeEndpointName(opts.baseUrl);
        this.model = opts.model;
    }
    async chat(req) {
        const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
        const doFetch = this.opts.fetchImpl ?? globalThis.fetch;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 60_000);
        try {
            const res = await doFetch(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${this.opts.apiKey}`,
                },
                body: JSON.stringify({
                    model: this.opts.model,
                    messages: [
                        ...(req.system ? [{ role: 'system', content: req.system }] : []),
                        { role: 'user', content: req.user },
                    ],
                    temperature: this.opts.temperature ?? 0.2,
                    ...(req.json ? { response_format: { type: 'json_object' } } : {}),
                    ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
                }),
                signal: controller.signal,
            });
            if (!res.ok) {
                throw new Error(`LLM 端点 ${url} 响应 ${res.status}：${await res.text()}`);
            }
            const body = (await res.json());
            const content = body.choices?.[0]?.message?.content;
            if (typeof content !== 'string')
                throw new Error('LLM 响应缺少 choices[0].message.content');
            return content;
        }
        finally {
            clearTimeout(timeout);
        }
    }
}
/** 端点友好名（provider.name 用） */
function normalizeEndpointName(baseUrl) {
    try {
        return new URL(baseUrl).host;
    }
    catch {
        return baseUrl;
    }
}
/**
 * 从环境变量构造 provider（密钥环境变量注入，36 施工案拍板）。
 * 优先级：
 * 1. MEMORY_LLM_API_KEY（+ MEMORY_LLM_BASE_URL 默认 DeepSeek + MEMORY_LLM_MODEL 默认 deepseek-chat）
 * 2. DEEPSEEK_API_KEY（baseUrl https://api.deepseek.com，model deepseek-chat）
 * 3. OPENAI_API_KEY（+ OPENAI_BASE_URL 默认 https://api.openai.com/v1 + OPENAI_MODEL 默认 gpt-4o-mini）
 * 无任何 key → undefined（调用方降级，不报错）。
 */
export function createProviderFromEnv(env) {
    const vars = env ?? firelinkIO.env();
    if (vars.MEMORY_LLM_API_KEY) {
        return new OpenAICompatibleProvider({
            baseUrl: vars.MEMORY_LLM_BASE_URL ?? 'https://api.deepseek.com',
            apiKey: vars.MEMORY_LLM_API_KEY,
            model: vars.MEMORY_LLM_MODEL ?? 'deepseek-chat',
        });
    }
    if (vars.DEEPSEEK_API_KEY) {
        return new OpenAICompatibleProvider({
            baseUrl: 'https://api.deepseek.com',
            apiKey: vars.DEEPSEEK_API_KEY,
            model: 'deepseek-chat',
        });
    }
    if (vars.OPENAI_API_KEY) {
        return new OpenAICompatibleProvider({
            baseUrl: vars.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
            apiKey: vars.OPENAI_API_KEY,
            model: vars.OPENAI_MODEL ?? 'gpt-4o-mini',
        });
    }
    return undefined;
}
/* ================================================================
 * 三、提示词模板（全部内置开源）
 * ===============================================================*/
export const PROMPTS = {
    weeklySummary: {
        system: '你是记忆提纯助手。请阅读一周的对话记录，写出 3-6 句客观摘要：' +
            '记录这段时间两人的重要事件、情绪变化、承诺与约定。只输出 JSON，不要输出任何其他文字。',
        user: (week) => `本周（${week.weekKey}，${week.start} ~ ${week.end}）对话记录如下：\n\n${week.transcript}\n\n` +
            '请输出 JSON：{"summary":"周摘要全文"}。',
    },
    anchorExtraction: {
        system: '你是记忆锚点抽取器。从一周对话中抽取值得长期记住的关键事件锚点（重要承诺、' +
            '纪念日、重大决定、情绪转折点、事实性信息）。每个锚点一句话，importance 取 1-3' +
            '（3 = 最重要的承诺/纪念日/关键事实）。只输出 JSON，不要输出任何其他文字。',
        user: (week) => `本周（${week.weekKey}）对话记录如下：\n\n${week.transcript}\n\n` +
            '请输出 JSON：{"anchors":[{"date":"YYYY-MM-DD","ts":毫秒时间戳或null,' +
            '"event":"一句话事件","importance":1到3}]}。最多 12 条，宁缺毋滥。',
    },
    layerTagging: {
        system: '你是记忆分层器。基于对话摘要与事件锚点，把值得沉淀的记忆分为三路：\n' +
            '1. longTerm（长期记忆）：不可遗忘的核心事实/身份/关系承诺，每条一句话；\n' +
            '2. notebook（笔记）：日常趣事/习惯/偏好，每条 ≤50 字；\n' +
            '3. profile（画像信号）：主人（user 侧）的稳定特征。\n' +
            '只输出 JSON，不要输出任何其他文字。',
        user: (input) => `对话摘要：\n${input.summaries}\n\n事件锚点：\n${input.anchors}\n\n` +
            '请输出 JSON：{"longTerm":[{"text":"...","category":"identity|relationship|core_fact"}],' +
            '"notebook":[{"text":"≤50字","score":0到10,"category":"general|relationship|habit|interest|event",' +
            '"reason":"≤30字为什么值得记"}],"profile":[{"dimension":"preferences|personality|habits",' +
            '"key":"特征键","value":"特征值"}]}。',
    },
};
/* ================================================================
 * 四、L3 主流程
 * ===============================================================*/
/** 无 provider 的降级结果工厂 */
export function skippedDistill(now = Date.now) {
    return {
        skipped: true,
        skipReason: 'no_provider',
        weeklySummaries: [],
        anchors: [],
        longTerm: [],
        notebook: [],
        profile: [],
        meta: { provider: null, generatedAt: new Date(now()).toISOString(), llmCalls: 0 },
    };
}
/** L3 提纯全量入口（内部按周分批调 provider；断点续跑版见闭源编排层） */
export async function distill(messages, options = {}) {
    const provider = options.provider;
    if (!provider)
        return skippedDistill(options.now ?? Date.now);
    const now = options.now ?? Date.now;
    const weeks = groupByWeek(messages);
    const weeklySummaries = [];
    const anchors = [];
    let llmCalls = 0;
    for (const week of weeks) {
        const r = await distillWeek(week, provider, options);
        weeklySummaries.push(r.summary);
        anchors.push(...r.anchors);
        llmCalls += r.llmCalls;
    }
    // 分层标签：基于摘要 + 锚点一次性产出三路
    const layering = await distillLayers(weeklySummaries, anchors, provider, now);
    llmCalls += 1;
    return {
        skipped: false,
        weeklySummaries,
        anchors,
        longTerm: layering.longTerm,
        notebook: layering.notebook,
        profile: layering.profile,
        meta: {
            provider: provider.name,
            model: provider.model,
            generatedAt: new Date(now()).toISOString(),
            llmCalls,
        },
    };
}
/** 单周提纯（周摘要 + 锚点；供断点续跑编排逐周调用） */
export async function distillWeek(week, provider, options = {}) {
    const maxChars = options.maxCharsPerWeek ?? 12000;
    const transcript = renderTranscript(week.messages, maxChars);
    const summaryRaw = await provider.chat({
        system: PROMPTS.weeklySummary.system,
        user: PROMPTS.weeklySummary.user({
            weekKey: week.weekKey,
            start: week.start,
            end: week.end,
            transcript,
        }),
        json: true,
    });
    const summaryParsed = extractJson(summaryRaw);
    const summary = {
        weekKey: week.weekKey,
        start: week.start,
        end: week.end,
        summary: typeof summaryParsed?.summary === 'string' ? summaryParsed.summary : '',
        messageCount: week.messages.length,
    };
    const anchorRaw = await provider.chat({
        system: PROMPTS.anchorExtraction.system,
        user: PROMPTS.anchorExtraction.user({ weekKey: week.weekKey, transcript }),
        json: true,
    });
    const anchorParsed = extractJson(anchorRaw);
    const anchors = Array.isArray(anchorParsed?.anchors)
        ? anchorParsed.anchors
            .filter(isAnchorShape)
            .map((a) => ({
            date: a.date,
            ts: typeof a.ts === 'number' ? a.ts : null,
            event: a.event,
            importance: typeof a.importance === 'number' ? a.importance : 3,
        }))
        : [];
    return { summary, anchors, llmCalls: 2 };
}
/** 分层标签（三路泛化输出） */
export async function distillLayers(weeklySummaries, anchors, provider, now = Date.now) {
    const summaries = weeklySummaries
        .map((w) => `- ${w.weekKey}：${w.summary}`)
        .join('\n');
    const anchorText = anchors
        .map((a) => `- ${a.date}（重要度${a.importance}）：${a.event}`)
        .join('\n');
    const raw = await provider.chat({
        system: PROMPTS.layerTagging.system,
        user: PROMPTS.layerTagging.user({ summaries, anchors: anchorText }),
        json: true,
    });
    const parsed = extractJson(raw);
    const longTerm = Array.isArray(parsed?.longTerm)
        ? parsed.longTerm.filter(isLongTermShape).map((i) => ({ text: i.text, category: i.category }))
        : [];
    const notebook = Array.isArray(parsed?.notebook)
        ? parsed.notebook.filter(isNotebookShape).map((i) => ({
            text: i.text,
            ...(typeof i.score === 'number' ? { score: i.score } : {}),
            ...(typeof i.category === 'string' ? { category: i.category } : {}),
            ...(typeof i.reason === 'string' ? { reason: i.reason } : {}),
        }))
        : [];
    const profile = Array.isArray(parsed?.profile)
        ? parsed.profile.filter(isProfileShape).map((i) => ({
            dimension: i.dimension,
            key: i.key,
            value: i.value,
        }))
        : [];
    return { longTerm, notebook, profile, generatedAt: new Date(now()).toISOString() };
}
/** 按自然周分组（ts null 的消息归入「未知时间」批） */
export function groupByWeek(messages) {
    const buckets = new Map();
    for (const m of messages) {
        const weekKey = m.ts === null ? 'unknown' : isoWeekKey(new Date(m.ts));
        let bucket = buckets.get(weekKey);
        if (!bucket) {
            const first = m.ts === null ? '未知时间' : new Date(m.ts).toISOString().slice(0, 10);
            bucket = { weekKey, start: first, end: first, messages: [] };
            buckets.set(weekKey, bucket);
        }
        bucket.messages.push(m);
        if (m.ts !== null) {
            const iso = new Date(m.ts).toISOString().slice(0, 10);
            if (iso < bucket.start)
                bucket.start = iso;
            if (iso > bucket.end)
                bucket.end = iso;
        }
    }
    // 按周键排序（unknown 在最后）
    return [...buckets.values()].sort((a, b) => a.weekKey === 'unknown' ? 1 : b.weekKey === 'unknown' ? -1 : a.weekKey.localeCompare(b.weekKey));
}
/** ISO 周键（2026-W24 形） */
export function isoWeekKey(date) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayNum = d.getUTCDay() || 7; // 周一=1...周日=7
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
/** 消息转录（时间线文本；超长截断） */
export function renderTranscript(messages, maxChars) {
    const lines = [];
    let used = 0;
    let truncated = 0;
    for (const m of messages) {
        const line = `${formatTs(m.ts)} ${m.role}: ${m.text}`;
        if (used + line.length > maxChars) {
            truncated++;
            continue;
        }
        lines.push(line);
        used += line.length;
    }
    if (truncated > 0)
        lines.push(`（另有 ${truncated} 条消息因长度上限未纳入转录）`);
    return lines.join('\n');
}
function formatTs(ts) {
    return ts === null ? '[--:--]' : new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}
/* ================================================================
 * 六、JSON 容错解析与形状校验
 * ===============================================================*/
/** 容错 JSON 提取（直接 parse → ```json 围栏 → 首尾括号截取） */
export function extractJson(text) {
    const trimmed = text.trim();
    try {
        return JSON.parse(trimmed);
    }
    catch {
        /* 降级解析 */
    }
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
        try {
            return JSON.parse(fenced[1].trim());
        }
        catch {
            /* 降级解析 */
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
function isAnchorShape(v) {
    const a = v;
    return (typeof a?.date === 'string' &&
        typeof a?.event === 'string' &&
        (typeof a?.ts === 'number' || a?.ts === null || a?.ts === undefined) &&
        (typeof a?.importance === 'number' || a?.importance === undefined));
}
function isLongTermShape(v) {
    const a = v;
    if (typeof a?.text !== 'string')
        return false;
    if (a.category === undefined)
        return true;
    return a.category === 'identity' || a.category === 'relationship' || a.category === 'core_fact';
}
function isNotebookShape(v) {
    const a = v;
    return (typeof a?.text === 'string' &&
        (a?.score === undefined || typeof a?.score === 'number') &&
        (a?.category === undefined || typeof a?.category === 'string') &&
        (a?.reason === undefined || typeof a?.reason === 'string'));
}
function isProfileShape(v) {
    const a = v;
    return ((a?.dimension === 'preferences' || a?.dimension === 'personality' || a?.dimension === 'habits') &&
        typeof a?.key === 'string' &&
        typeof a?.value === 'string');
}
