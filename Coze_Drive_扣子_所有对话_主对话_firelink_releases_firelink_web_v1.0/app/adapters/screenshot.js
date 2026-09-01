/*
 * 传火（firelink）· 开源记忆加工内核 · L0 适配器 · 截图转写
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
 * L0 适配器：截图转写（多模态 LLM，36 施工案 36.2）
 * ---------------------------------------------------------------
 * - provider 可插拔 BYO key：实现 MultimodalProvider 接口即可替换
 *   （内置 OpenAIVisionProvider 走任意 OpenAI 兼容视觉端点；密钥由调用方注入）
 * - 转写提示词模板内置（P0 沉淀）；输出契约与纯文本转写一致：
 *   JSON 数组 [{role, text}]（界面元素不转写、原文不改写）
 * - provider 输出不可解析 → 降级：整段输出保留为单条待标注消息（不报错）；
 *   未提供 provider → 明确报错（截图无 LLM 无兜底路径）
 * - 图片 MIME 按魔数嗅探（PNG/JPEG/GIF/WEBP），路径输入按扩展名兜底
 * 输入：图片字节 / 本地图片路径。
 */
import { firelinkIO } from '../io-impl.js';
import { buildL0Result, extractJsonArrayFromText, isBytesInput, isPathInput, readPathBytes, } from './common.js';
/* ================================================================
 * 一、内置转写提示词（36 施工案 36.2 拍板：模板沉淀于适配器内）
 * ===============================================================*/
export const PROMPT_SCREENSHOT_TRANSCRIBE = '你是聊天记录截图的结构化转写助手。请把这张截图中的对话内容按从上到下的阅读顺序' +
    '逐条转写为 JSON 数组：[{"role":"user"|"assistant"|"system"|"unlabeled","text":"消息文字"}]。' +
    '规则：保持原文，不改写、不翻译、不补全；截图中的界面元素（按钮、菜单、时间栏、输入框占位）不要转写；' +
    '无法判断说话方的消息标 "unlabeled"；没有对话内容时输出 []。只输出 JSON，不要输出任何其他文字。';
/** OpenAI 兼容视觉端点 provider（/chat/completions 多模态 content 协议） */
export class OpenAIVisionProvider {
    name;
    model;
    opts;
    constructor(opts) {
        this.opts = opts;
        this.name = normalizeEndpointName(opts.baseUrl);
        this.model = opts.model;
    }
    async transcribe(req) {
        const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
        const doFetch = this.opts.fetchImpl ?? globalThis.fetch;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 90_000);
        try {
            const dataUri = `data:${req.mimeType};base64,${firelinkIO.base64Encode(req.image)}`;
            const res = await doFetch(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${this.opts.apiKey}`,
                },
                body: JSON.stringify({
                    model: this.opts.model,
                    messages: [
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: req.prompt },
                                { type: 'image_url', image_url: { url: dataUri } },
                            ],
                        },
                    ],
                    temperature: this.opts.temperature ?? 0.1,
                }),
                signal: controller.signal,
            });
            if (!res.ok) {
                throw new Error(`多模态端点 ${url} 响应 ${res.status}：${await res.text()}`);
            }
            const body = (await res.json());
            const content = body.choices?.[0]?.message?.content;
            if (typeof content !== 'string')
                throw new Error('多模态端点响应缺少 choices[0].message.content');
            return content;
        }
        finally {
            clearTimeout(timer);
        }
    }
}
function normalizeEndpointName(baseUrl) {
    try {
        return new URL(baseUrl).host;
    }
    catch {
        return baseUrl;
    }
}
/* ================================================================
 * 三、图片形态嗅探
 * ===============================================================*/
/** 图片魔数嗅探（PNG/JPEG/GIF/WEBP）；未知返回 null */
export function sniffImageMime(data) {
    if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
        return 'image/png';
    }
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return 'image/jpeg';
    }
    if (data.length >= 3 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
        return 'image/gif';
    }
    if (data.length >= 12 &&
        data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
        data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
        return 'image/webp';
    }
    return null;
}
function mimeFromPath(path) {
    const ext = path.toLowerCase().split('.').pop() ?? '';
    if (ext === 'png' || ext === 'jpg' || ext === 'jpeg')
        return ext === 'png' ? 'image/png' : 'image/jpeg';
    if (ext === 'gif')
        return 'image/gif';
    if (ext === 'webp')
        return 'image/webp';
    return null;
}
/* ================================================================
 * 四、主转换
 * ===============================================================*/
export async function adaptScreenshot(input, options = {}) {
    const provider = options.multimodal;
    if (!provider) {
        throw new Error('截图转写需要多模态 LLM provider（BYO key）：请在 options.multimodal 注入实现 MultimodalProvider 的实例');
    }
    const { image, mimeType } = await resolveImage(input);
    const raw = await provider.transcribe({
        image,
        mimeType,
        prompt: PROMPT_SCREENSHOT_TRANSCRIBE,
    });
    // 解析 JSON 契约输出
    const items = extractJsonArrayFromText(raw);
    if (items !== null && items.length > 0) {
        const messages = [];
        for (const item of items) {
            const text = typeof item?.text === 'string' ? item.text.trim() : '';
            if (text.length === 0)
                continue;
            messages.push({
                role: normalizeSimpleRole(item?.role),
                text,
                ts: null,
                meta: { source: 'screenshot', mimeType, llmRoleLabel: true },
            });
        }
        if (messages.length > 0) {
            return buildL0Result(messages, {
                meta: { adapter: 'screenshot', mimeType, provider: provider.name, parseMode: 'json' },
            });
        }
    }
    // LLM 输出不可解析 → 降级：整段输出保留为单条待标注消息（不报错）
    const fallback = raw.trim();
    if (fallback.length === 0) {
        throw new Error('截图转写：provider 返回空内容');
    }
    return buildL0Result([
        {
            role: 'unlabeled',
            text: fallback,
            ts: null,
            meta: { source: 'screenshot', mimeType, pendingLabel: true },
        },
    ], { meta: { adapter: 'screenshot', mimeType, provider: provider.name, parseMode: 'fallback' } });
}
async function resolveImage(input) {
    if (isBytesInput(input)) {
        return { image: input, mimeType: sniffImageMime(input) ?? 'image/png' };
    }
    if (isPathInput(input)) {
        const bytes = await readPathBytes(input.path);
        return { image: bytes, mimeType: sniffImageMime(bytes) ?? mimeFromPath(input.path) ?? 'image/png' };
    }
    throw new Error('截图转写：不支持的输入形态（期待图片字节或本地图片路径）');
}
function normalizeSimpleRole(role) {
    if (role === 'user' || role === 'assistant' || role === 'system')
        return role;
    return 'unlabeled';
}
/* ================================================================
 * 五、适配器对象
 * ===============================================================*/
export const screenshotAdapter = {
    name: 'screenshot',
    label: '截图转写（多模态）',
    description: '截图 → 多模态 LLM 转写（BYO key，provider 可插拔；内置 OpenAI 兼容视觉端点实现与转写提示词模板）',
    convert: (input, options) => adaptScreenshot(input, options),
};
