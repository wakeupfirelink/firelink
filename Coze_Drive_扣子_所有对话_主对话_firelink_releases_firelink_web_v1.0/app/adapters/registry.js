/*
 * 传火（firelink）· 开源记忆加工内核 · L0 适配器层 · 统一注册表
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
 * L0 适配器统一注册表（36 施工案 36.2）
 * ---------------------------------------------------------------
 * - 名字 → 适配器映射（8 个：7 开源 + 1 闭源接入位占位）
 * - 来源类型自动嗅探（供 lite 总装可选暴露）：文本/JSON/JSONL/HTML 特征、
 *   ZIP 内文件清单、图片魔数、路径扩展名 → 适配器名
 * - runLiteFromSource：嗅探（或显式指定）→ 适配器 → 统一 schema →
 *   runLitePipeline 全链（clean→structure→distill 可选→mempack 三格式）
 */
import { DEFAULT_MESSAGE_BOUNDARY } from '../clean.js';
import { runLitePipeline } from '../lite.js';
import { decodeUtf8, isBytesInput, isFilesInput, isPathInput, readPathBytes, tryParseJson, } from './common.js';
import { findZipEntry, isZipData, readZipEntries } from './zip.js';
import { chatgptAdapter } from './chatgpt.js';
import { claudeAdapter } from './claude.js';
import { characteraiAdapter } from './characterai.js';
import { txtDocxAdapter } from './txt-docx.js';
import { stChatlogAdapter } from './st-chatlog.js';
import { localWebAdapter } from './local-web.js';
import { screenshotAdapter, sniffImageMime } from './screenshot.js';
import { qqExportAdapter } from './qq-export.js';
/* ================================================================
 * 一、注册表
 * ===============================================================*/
/** 统一注册表（名字 → 适配器） */
export const L0_ADAPTERS = {
    [chatgptAdapter.name]: chatgptAdapter,
    [claudeAdapter.name]: claudeAdapter,
    [characteraiAdapter.name]: characteraiAdapter,
    [txtDocxAdapter.name]: txtDocxAdapter,
    [stChatlogAdapter.name]: stChatlogAdapter,
    [localWebAdapter.name]: localWebAdapter,
    [screenshotAdapter.name]: screenshotAdapter,
    [qqExportAdapter.name]: qqExportAdapter,
};
/** 按名取适配器（未注册返回 undefined） */
export function getL0Adapter(name) {
    return L0_ADAPTERS[name];
}
/** 注册表清单（向导「选来源」用） */
export function listL0Adapters() {
    return Object.values(L0_ADAPTERS).map((a) => ({
        name: a.name,
        label: a.label,
        description: a.description,
        status: a.status ?? 'ready',
    }));
}
/** 统一转换入口（按名或直接传适配器实例） */
export async function convertWithAdapter(nameOrAdapter, input, options) {
    const adapter = typeof nameOrAdapter === 'string' ? getL0Adapter(nameOrAdapter) : nameOrAdapter;
    if (!adapter) {
        throw new Error(`未注册的适配器：${String(nameOrAdapter)}（可用：${Object.keys(L0_ADAPTERS).join(', ')}）`);
    }
    return adapter.convert(input, options);
}
/** 来源类型嗅探：原始输入 → 适配器名（无法判定返回 null） */
export async function sniffL0Source(input) {
    if (isBytesInput(input))
        return await sniffBytes(input);
    if (isPathInput(input))
        return await sniffPathInput(input.path);
    if (isFilesInput(input)) {
        const keys = Object.keys(input.files).map((k) => k.replace(/\\/g, '/').split('/').pop() ?? k);
        if (keys.includes('message.json') || keys.includes('character.json')) {
            return { name: 'characterai', confidence: 'high', reason: '三文件映射（message.json/character.json 特征）' };
        }
        return null;
    }
    if (typeof input === 'string')
        return sniffText(input);
    return sniffParsed(input);
}
/** 二进制嗅探：ZIP 内文件清单 → docx / 三件套；图片魔数 → 截图
 *  （37 案 T1 注：readZipEntries 已异步化——deflate 解压走 IO 层） */
async function sniffBytes(data) {
    if (isZipData(data)) {
        try {
            const entries = await readZipEntries(data);
            if (findZipEntry(entries, 'document.xml')) {
                return { name: 'txt-docx', confidence: 'high', reason: 'ZIP 内含 word/document.xml（docx）' };
            }
            if (findZipEntry(entries, 'message.json') && findZipEntry(entries, 'character.json')) {
                return { name: 'characterai', confidence: 'high', reason: 'ZIP 内含 character.json + message.json' };
            }
        }
        catch {
            // ZIP 解析失败 → 无法判定
        }
        return null;
    }
    const mime = sniffImageMime(data);
    if (mime !== null) {
        return { name: 'screenshot', confidence: 'high', reason: `图片魔数（${mime}）` };
    }
    return null;
}
/** 路径嗅探：扩展名分派 + 内容兜底 */
async function sniffPathInput(path) {
    const ext = path.toLowerCase().split('.').pop() ?? '';
    if (ext === 'docx')
        return { name: 'txt-docx', confidence: 'high', reason: '扩展名 .docx' };
    if (ext === 'zip') {
        try {
            return await sniffBytes(await readPathBytes(path));
        }
        catch {
            return null;
        }
    }
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
        return { name: 'screenshot', confidence: 'high', reason: `扩展名 .${ext}` };
    }
    if (['html', 'htm'].includes(ext)) {
        return { name: 'local-web', confidence: 'high', reason: `扩展名 .${ext}` };
    }
    if (ext === 'jsonl')
        return { name: 'st-chatlog', confidence: 'high', reason: '扩展名 .jsonl' };
    try {
        const bytes = await readPathBytes(path);
        if (isZipData(bytes))
            return await sniffBytes(bytes);
        return sniffText(decodeUtf8(bytes));
    }
    catch {
        return null;
    }
}
/** 文本嗅探：HTML 特征 / JSONL 特征 / 整体 JSON / 消息头特征 */
function sniffText(text) {
    const t = text.replace(/^\uFEFF/, '').trim();
    if (t.startsWith('<'))
        return { name: 'local-web', confidence: 'high', reason: 'HTML 文档特征（< 开头）' };
    // JSONL 逐行判定（容忍首行会话元数据变体）
    const lines = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length > 0) {
        let stMessages = 0;
        let bad = false;
        for (const line of lines) {
            const p = tryParseJson(line);
            if (p === undefined || p === null || typeof p !== 'object' || Array.isArray(p)) {
                bad = true;
                break;
            }
            const rec = p;
            if ('mes' in rec && ('is_user' in rec || 'is_system' in rec))
                stMessages++;
            else if (!('user_name' in rec || 'character_name' in rec)) {
                bad = true;
                break;
            }
        }
        if (!bad && stMessages >= 1) {
            return { name: 'st-chatlog', confidence: 'high', reason: `JSONL ${stMessages} 条消息（mes/is_user 特征）` };
        }
    }
    const parsed = tryParseJson(t);
    if (parsed !== undefined) {
        const r = sniffParsed(parsed);
        if (r !== null)
            return r;
    }
    // 消息头特征（与 clean.ts 默认边界同构）
    const boundaryRe = new RegExp(DEFAULT_MESSAGE_BOUNDARY.pattern, 'g');
    let count = 0;
    while (boundaryRe.exec(t) !== null)
        count++;
    if (count >= 2)
        return { name: 'txt-docx', confidence: 'low', reason: `检测到 ${count} 处消息头模式` };
    return null;
}
/** 已解析 JSON 嗅探：mapping / chat_messages / raw_content 特征 */
function sniffParsed(parsed) {
    if (Array.isArray(parsed)) {
        if (parsed.some((c) => hasField(c, 'mapping'))) {
            return { name: 'chatgpt', confidence: 'high', reason: '会话对象含 mapping 消息树' };
        }
        if (parsed.some((c) => hasField(c, 'chat_messages'))) {
            return { name: 'claude', confidence: 'high', reason: '会话对象含 chat_messages' };
        }
        if (parsed.some((c) => hasRawContent(c))) {
            return { name: 'characterai', confidence: 'high', reason: '消息对象含 raw_content' };
        }
        return null;
    }
    if (parsed !== null && typeof parsed === 'object') {
        const obj = parsed;
        if (Array.isArray(obj.conversations))
            return sniffParsed(obj.conversations);
        if (hasField(obj, 'mapping'))
            return { name: 'chatgpt', confidence: 'high', reason: '会话对象含 mapping 消息树' };
        if (hasField(obj, 'chat_messages'))
            return { name: 'claude', confidence: 'high', reason: '会话对象含 chat_messages' };
    }
    return null;
}
function hasField(v, field) {
    return typeof v === 'object' && v !== null && field in v;
}
function hasRawContent(v) {
    if (typeof v !== 'object' || v === null)
        return false;
    if (hasField(v, 'raw_content'))
        return true;
    const src = v.src;
    return hasField(src, 'raw_content');
}
/** 来源 → 记忆包一步到位（36 施工案 36.2：lite 总装 + 来源类型自动嗅探） */
export async function runLiteFromSource(options) {
    let name = options.adapter;
    let sniffed = false;
    let confidence;
    if (name === undefined) {
        const sniff = await sniffL0Source(options.input);
        if (sniff === null) {
            throw new Error(`无法识别来源类型：请显式指定 adapter（可用：${Object.keys(L0_ADAPTERS).join(', ')}）`);
        }
        name = sniff.name;
        sniffed = true;
        confidence = sniff.confidence;
    }
    const adapter = getL0Adapter(name);
    if (!adapter)
        throw new Error(`未注册的适配器：${name}`);
    const adapterOptions = { ...options.adapterOptions };
    if (options.provider !== undefined)
        adapterOptions.provider = options.provider;
    const l0 = await adapter.convert(options.input, adapterOptions);
    const lite = await runLitePipeline({
        ...(options.lite ?? {}),
        input: l0.messages,
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
    });
    return {
        ...lite,
        adapter: { name, sniffed, ...(confidence !== undefined ? { confidence } : {}) },
        l0,
    };
}
/* ================================================================
 * 四、便捷再导出（适配器层用户只需 import 本文件）
 * ===============================================================*/
export { chatgptAdapter, adaptChatGPT } from './chatgpt.js';
export { claudeAdapter, adaptClaude } from './claude.js';
export { characteraiAdapter, adaptCharacterAI } from './characterai.js';
export { txtDocxAdapter, adaptTxtDocx } from './txt-docx.js';
export { stChatlogAdapter, adaptStChatlog } from './st-chatlog.js';
export { localWebAdapter, adaptLocalWeb, extractHtmlTextBlocks } from './local-web.js';
export { screenshotAdapter, adaptScreenshot, OpenAIVisionProvider, PROMPT_SCREENSHOT_TRANSCRIBE, } from './screenshot.js';
export { qqExportAdapter, NotImplementedError } from './qq-export.js';
export { readZipEntries, isZipData, findZipEntry, docxParagraphLines, decodeXmlEntities } from './zip.js';
