/*
 * 传火（firelink）· 开源记忆加工内核 · L0 适配器 · 纯文本 / Word 聊天记录
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
 * L0 适配器：纯文本 / Word 聊天记录（36 施工案 36.2）
 * ---------------------------------------------------------------
 * - .docx：零依赖自实现 zip+xml 提取（word/document.xml → 段落文本行，
 *   不引外部协议库）；.txt/.md 直读
 * - 段头格式（docx 导出惯例「名字: MM-DD HH:MM:SS 正文」，含长行内嵌多消息）：
 *   确定性解析（复用 open/structure.ts 段头解析 + roleAliases），零 LLM
 * - 无段头纯文本：LLM 分角色（复用 36.1 沉淀于 open/structure.ts 的
 *   P0 转写提示词模板 + provider 抽象，BYO key）；无 key 自动降级——
 *   按行保留原文待标注，不报错
 * 输入：txt 文本 / docx 字节 / 文件路径（按扩展名分派）。
 */
import { buildL0Result, decodeUtf8, isBytesInput, isFilesInput, isPathInput, readPathBytes, readPathText, structureChatText, } from './common.js';
import { decodeXmlEntities, docxParagraphLines, findZipEntry, isZipData, readZipEntries } from './zip.js';
/* ================================================================
 * 一、主转换
 * ===============================================================*/
export async function adaptTxtDocx(input, options = {}) {
    const text = await extractText(input);
    if (text.trim().length === 0) {
        throw new Error('txt-docx 适配器：未提取到文本内容');
    }
    const outcome = await structureChatText(text, options);
    return buildL0Result(outcome.messages, {
        pendingLabel: outcome.pendingLabel,
        llmAssisted: outcome.llmAssisted,
        meta: {
            adapter: 'txt-docx',
            mode: outcome.mode,
            boundaryCount: outcome.boundaryCount,
            llmUsed: outcome.llmAssisted > 0,
        },
    });
}
/* ================================================================
 * 二、文本提取（txt 直读 / docx 零依赖 zip+xml）
 * ===============================================================*/
async function extractText(input) {
    if (typeof input === 'string')
        return input;
    if (isPathInput(input)) {
        if (/\.docx$/i.test(input.path))
            return await docxToText(await readPathBytes(input.path));
        return await readPathText(input.path); // .txt / .md / 其他文本文件
    }
    if (isBytesInput(input)) {
        if (isZipData(input))
            return await docxToText(input);
        return decodeUtf8(input); // 纯文本字节
    }
    if (isFilesInput(input)) {
        const values = Object.values(input.files);
        if (values.length === 1) {
            const v = values[0];
            if (typeof v === 'string')
                return v;
            if (v instanceof Uint8Array)
                return isZipData(v) ? await docxToText(v) : decodeUtf8(v);
        }
    }
    throw new Error('txt-docx 适配器：不支持的输入形态（期待 txt 文本、docx 字节或文件路径）');
}
/** docx 字节 → 全文文本（word/document.xml 段落行拼接；异步：zip 解压走 IO 层） */
async function docxToText(bytes) {
    const entries = await readZipEntries(bytes);
    const doc = findZipEntry(entries, 'document.xml');
    if (!doc)
        throw new Error('txt-docx 适配器：docx 内未找到 word/document.xml');
    return docxParagraphLines(decodeUtf8(doc.data)).join('\n');
}
/** 导出：XML 实体解码（docx 正文透出给调用方复用） */
export { decodeXmlEntities };
/* ================================================================
 * 三、适配器对象
 * ===============================================================*/
export const txtDocxAdapter = {
    name: 'txt-docx',
    label: '纯文本 / Word 聊天记录',
    description: 'txt 直读 + docx 零依赖 zip+xml 提取；段头格式确定性解析（roleAliases）；无段头纯文本 LLM 分角色（BYO key，无 key 保留原文待标注不报错）',
    convert: (input, options) => adaptTxtDocx(input, options),
};
