/*
 * 传火（firelink）· 开源记忆加工内核 · L0 适配器 · 本地保存的 HTML 页面正文
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
 * L0 适配器：本地保存的 HTML 页面正文提取（36 施工案 36.2）
 * ---------------------------------------------------------------
 * C 类关停平台的兜底路径：用户「另存为页面」的聊天存档 → 正文提取 → 统一 schema。
 * - 提取 <title> 记入来源摘要；剔除 script/style/noscript/template/svg/注释
 * - 块级标签（p/div/li/tr/h1-h6 等）切行、<br> 换行、行内标签剔除、实体解码
 * - 提取的正文块走与 txt-docx 相同的结构化分派：段头格式（「名字: MM-DD
 *   HH:MM:SS 正文」）确定性解析 / 无段头时 LLM 分角色（BYO key，无 key
 *   保留原文待标注，不报错）
 * 输入：HTML 文本 / 字节 / 本地页面文件路径。
 */
import { buildL0Result, decodeUtf8, isBytesInput, isPathInput, readPathText, structureChatText, } from './common.js';
/** HTML → 标题 + 正文块序列（零依赖正则提取，不做完整 DOM 解析） */
export function extractHtmlTextBlocks(html) {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch
        ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
        : null;
    let s = html;
    s = s.replace(/<!--[\s\S]*?-->/g, ' '); // 注释
    s = s.replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
    s = s.replace(/<br\s*\/?>/gi, '\n'); // 换行
    s = s.replace(/<\/?(?:p|div|li|tr|h[1-6]|blockquote|section|article|ul|ol|table|pre|td|th|dt|dd|hr|article)\b[^>]*>/gi, '\n'); // 块级边界
    s = s.replace(/<[^>]+>/g, ' '); // 其余行内标签
    s = decodeHtmlEntities(s);
    const blocks = s
        .split(/\n+/)
        .map((b) => b.replace(/[ \t\u00a0]+/g, ' ').trim())
        .filter((b) => b.length > 0);
    return { title, blocks };
}
/** HTML 实体解码（数值实体在前，&amp; 最后防双重解码） */
function decodeHtmlEntities(s) {
    return s
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&mdash;/g, '—')
        .replace(/&hellip;/g, '…')
        .replace(/&amp;/g, '&');
}
function safeCodePoint(code) {
    try {
        return String.fromCodePoint(code);
    }
    catch {
        return '';
    }
}
/* ================================================================
 * 二、主转换
 * ===============================================================*/
export async function adaptLocalWeb(input, options = {}) {
    let html;
    if (typeof input === 'string')
        html = input;
    else if (isPathInput(input))
        html = await readPathText(input.path);
    else if (isBytesInput(input))
        html = decodeUtf8(input);
    else
        throw new Error('local-web 适配器：不支持的输入形态（期待 HTML 文本或本地页面路径）');
    const { title, blocks } = extractHtmlTextBlocks(html);
    if (blocks.length === 0) {
        throw new Error('local-web 适配器：页面未提取到正文内容');
    }
    const outcome = await structureChatText(blocks.join('\n'), options);
    return buildL0Result(outcome.messages, {
        pendingLabel: outcome.pendingLabel,
        llmAssisted: outcome.llmAssisted,
        meta: {
            adapter: 'local-web',
            title,
            mode: outcome.mode,
            blocks: blocks.length,
        },
    });
}
/* ================================================================
 * 三、适配器对象
 * ===============================================================*/
export const localWebAdapter = {
    name: 'local-web',
    label: '本地保存的 HTML 页面',
    description: '关停平台兜底路径：另存页面正文提取（script/style 剔除、块级切行、实体解码）；段头确定性解析或 LLM 分角色（BYO key）',
    convert: (input, options) => adaptLocalWeb(input, options),
};
