/*
 * 传火（firelink）· 开源记忆加工内核 · L0 适配器层 · ZIP/XML 提取工具
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
 * 零依赖 ZIP 读取 + docx XML 文本提取（36 施工案 36.2 拍板：优先零依赖自实现，
 * 不引外部协议库）。
 * - ZIP：中央目录解析 + stored/deflate 两种压缩（node:zlib inflateRawSync）
 * - docx：word/document.xml → 段落文本行（w:t 拼接 / w:br 换行 / w:tab 制表）
 * 局限（解析失败即抛错，不静默）：加密条目、ZIP64。
 */
import { firelinkIO } from '../io-impl.js';
/** ZIP 魔数判定（PK\x03\x04 本地头 / PK\x05\x06 空档 EOCD） */
export function isZipData(data) {
    if (data.length < 4)
        return false;
    if (data[0] !== 0x50 || data[1] !== 0x4b)
        return false;
    if (data[2] === 0x03 && data[3] === 0x04)
        return true;
    if (data[2] === 0x05 && data[3] === 0x06)
        return true;
    return false;
}
/** 读取 ZIP 全部条目（按中央目录；stored/deflate；加密与 ZIP64 抛错）
 *  37 案 T1 注：deflate 解压走 IO 层（Node 用 node:zlib；浏览器用
 *  DecompressionStream），故本函数为异步——调用方需 await。 */
export async function readZipEntries(data) {
    if (!isZipData(data))
        throw new Error('不是有效的 ZIP 数据（缺少 PK 文件头）');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const decoder = new TextDecoder('utf-8');
    // 1) 回扫 EOCD（End of Central Directory：签名 0x06054b50，尾注最长 65535）
    let eocd = -1;
    const scanStart = Math.max(0, data.length - 22 - 65535);
    for (let i = data.length - 22; i >= scanStart; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0)
        throw new Error('ZIP 解析失败：未找到中央目录结束记录（EOCD）');
    const entryCount = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    const entries = [];
    // 2) 遍历中央目录记录（签名 0x02014b50）
    for (let i = 0; i < entryCount; i++) {
        if (offset + 46 > data.length || view.getUint32(offset, true) !== 0x02014b50) {
            throw new Error('ZIP 解析失败：中央目录记录损坏');
        }
        const flags = view.getUint16(offset + 8, true);
        const method = view.getUint16(offset + 10, true);
        const compSize = view.getUint32(offset + 20, true);
        const nameLen = view.getUint16(offset + 28, true);
        const extraLen = view.getUint16(offset + 30, true);
        const commentLen = view.getUint16(offset + 32, true);
        const localOffset = view.getUint32(offset + 42, true);
        const name = decoder.decode(data.subarray(offset + 46, offset + 46 + nameLen));
        if ((flags & 0x1) !== 0)
            throw new Error(`ZIP 条目 "${name}" 使用了加密，无法读取`);
        if (localOffset === 0xffffffff || compSize === 0xffffffff) {
            throw new Error(`ZIP 条目 "${name}" 使用 ZIP64，暂不支持`);
        }
        // 3) 本地文件头（签名 0x04034b50）→ 数据区
        if (localOffset + 30 > data.length || view.getUint32(localOffset, true) !== 0x04034b50) {
            throw new Error(`ZIP 条目 "${name}" 本地文件头损坏`);
        }
        const lNameLen = view.getUint16(localOffset + 26, true);
        const lExtraLen = view.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + lNameLen + lExtraLen;
        const raw = data.subarray(dataStart, dataStart + compSize);
        let content;
        if (method === 0)
            content = new Uint8Array(raw); // stored：原样
        else if (method === 8)
            content = await firelinkIO.inflateRaw(raw); // deflate
        else
            throw new Error(`ZIP 条目 "${name}" 使用压缩方式 ${method}，暂不支持`);
        entries.push({ name, data: content });
        offset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}
/** 按文件基名查找条目（兼容任意目录层级与反斜杠路径） */
export function findZipEntry(entries, basename) {
    return entries.find((e) => (e.name.replace(/\\/g, '/').split('/').pop() ?? e.name) === basename);
}
/* ================================================================
 * 二、XML 工具（docx 正文提取用）
 * ===============================================================*/
/** XML 实体解码（数值实体在前，&amp; 最后防双重解码） */
export function decodeXmlEntities(s) {
    return s
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
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
/**
 * word/document.xml → 段落文本行：
 * 每个 <w:p> 为一段，段内 <w:t> 文本按出现顺序拼接，
 * <w:br/> 换行、<w:tab/> 制表；空段落与空行丢弃。
 */
export function docxParagraphLines(xml) {
    const lines = [];
    for (const paragraph of xml.split(/<\/w:p>/)) {
        let text = '';
        const tokenRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t(?:\s[^>]*)?\/>|<w:br\s*\/?>|<w:tab\s*\/?>/g;
        let m;
        while ((m = tokenRe.exec(paragraph)) !== null) {
            if (m[1] !== undefined)
                text += decodeXmlEntities(m[1]);
            else if (m[0].startsWith('<w:br'))
                text += '\n';
            else if (m[0].startsWith('<w:tab'))
                text += '\t';
        }
        for (const piece of text.split('\n')) {
            const t = piece.trim();
            if (t.length > 0)
                lines.push(t);
        }
    }
    return lines;
}
