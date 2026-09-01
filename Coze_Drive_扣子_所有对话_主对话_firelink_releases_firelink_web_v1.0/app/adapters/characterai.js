/*
 * 传火（firelink）· 开源记忆加工内核 · L0 适配器 · Character.AI 官方导出
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
 * L0 适配器：Character.AI 官方导出 ZIP（36 施工案 36.2）
 * ---------------------------------------------------------------
 * 三文件关联映射（官方导出 ZIP：<用户名>/data/{user,character,message}.json）：
 * - user.json：账号信息（first_name 等 → 用户侧说话人名）
 * - character.json：角色信息（name/title → 角色侧说话人名）
 * - message.json：消息数组——**消息文本取 raw_content 字段**（官方格式要点，
 *   旧脚本误取 text 字段会得到空结果）；src 子对象与顶层字段两种形态均兼容
 * - 角色：is_human → user/assistant；缺失时按说话人名与 user/character 名
 *   匹配推断；仍无法判定 → unlabeled（保留原文待标注）
 * - 时间：created_at/created（ISO）→ ms；导出可能乱序，全量有时间则稳定排序
 * 输入：ZIP 字节 / ZIP 路径 / 三文件映射 / message.json 文本或路径。
 */
import { buildL0Result, decodeUtf8, epochToMs, isBytesInput, isFilesInput, isPathInput, parseIsoTs, readPathBytes, readPathText, tryParseJson, } from './common.js';
import { findZipEntry, isZipData, readZipEntries } from './zip.js';
/* ================================================================
 * 二、主转换
 * ===============================================================*/
export async function adaptCharacterAI(input) {
    const files = await resolveCAIFiles(input);
    const userName = pickString(files.user, ['first_name', 'username', 'user_name', 'name']);
    const characterName = pickString(files.character, ['name', 'title']);
    if (files.messages.length === 0) {
        throw new Error('characterai 适配器：未识别到消息数据（期待官方导出 ZIP 内 message.json，或三文件内容映射）');
    }
    const parsed = [];
    let skipped = 0;
    for (const item of files.messages) {
        if (item === null || typeof item !== 'object') {
            skipped++;
            continue;
        }
        const entry = item;
        const src = typeof entry.src === 'object' && entry.src !== null
            ? entry.src
            : null;
        // 消息文本：raw_content 字段（src 子对象优先，顶层兜底）
        const text = firstNonEmptyString(src?.raw_content, entry.raw_content);
        if (text === null) {
            skipped++;
            continue;
        }
        // 角色：is_human 显式判定 → 说话人名推断 → unlabeled 待标注
        const isHuman = typeof src?.is_human === 'boolean'
            ? src.is_human
            : typeof entry.is_human === 'boolean'
                ? entry.is_human
                : undefined;
        const speaker = firstNonEmptyString(src?.name, entry.name);
        let role;
        let pendingLabel = false;
        if (isHuman === true)
            role = 'user';
        else if (isHuman === false)
            role = 'assistant';
        else if (speaker !== null && speaker === userName)
            role = 'user';
        else if (speaker !== null && speaker === characterName)
            role = 'assistant';
        else {
            role = 'unlabeled';
            pendingLabel = true;
        }
        const ts = parseIsoTs(firstNonEmptyString(entry.created_at, src?.created_at)) ??
            parseIsoTs(firstNonEmptyString(entry.created, entry.timestamp)) ??
            epochToMs(entry.create_time);
        parsed.push({ role, text, ts, speaker, pendingLabel });
    }
    // 导出消息可能乱序：全量有时间戳则按时间稳定排序，否则保持原序
    let sortedByTime = false;
    if (parsed.length > 1 && parsed.every((m) => m.ts !== null)) {
        parsed.sort((a, b) => a.ts - b.ts);
        sortedByTime = true;
    }
    const messages = parsed.map((m) => ({
        role: m.role,
        text: m.text,
        ts: m.ts,
        meta: {
            source: 'characterai',
            ...(m.speaker !== null ? { speaker: m.speaker } : {}),
            ...(m.pendingLabel ? { pendingLabel: true } : {}),
        },
    }));
    return buildL0Result(messages, {
        skipped,
        meta: {
            adapter: 'characterai',
            userName: userName ?? null,
            characterName: characterName ?? null,
            messagesInFile: files.messages.length,
            sortedByTime,
            skipped,
        },
    });
}
/* ================================================================
 * 三、三文件解析（ZIP / 文件映射 / 文本）
 * ===============================================================*/
async function resolveCAIFiles(input) {
    // 1) 三文件映射（kind: 'files'）或已解析对象 {user, character, message(s)}
    if (isFilesInput(input))
        return filesFromMap(input.files);
    if (typeof input === 'object' && input !== null && !isBytesInput(input)) {
        const obj = input;
        if (['user', 'character', 'message', 'messages'].some((k) => k in obj) &&
            obj.kind === undefined) {
            return filesFromMap(obj);
        }
    }
    // 2) ZIP（字节或路径）
    let zipBytes = null;
    if (isBytesInput(input))
        zipBytes = input;
    else if (isPathInput(input)) {
        if (/\.zip$/i.test(input.path)) {
            zipBytes = await readPathBytes(input.path);
        }
        else if (/\.json$/i.test(input.path)) {
            return { user: null, character: null, messages: parseMessageArray(await readPathText(input.path)) };
        }
        else {
            const bytes = await readPathBytes(input.path);
            if (isZipData(bytes))
                zipBytes = bytes;
            else
                return { user: null, character: null, messages: parseMessageArray(decodeUtf8(bytes)) };
        }
    }
    if (zipBytes !== null) {
        const entries = await readZipEntries(zipBytes);
        const messageEntry = findZipEntry(entries, 'message.json');
        if (!messageEntry) {
            throw new Error('characterai 适配器：ZIP 内未找到 message.json（期待官方导出 ZIP：<用户名>/data/{user,character,message}.json）');
        }
        return {
            user: parseJsonObject(findZipEntry(entries, 'user.json')),
            character: parseJsonObject(findZipEntry(entries, 'character.json')),
            messages: parseMessageArray(decodeUtf8(messageEntry.data)),
        };
    }
    // 3) 字符串：message.json 文本（user/character 缺省 → is_human 判定角色）
    if (typeof input === 'string') {
        return { user: null, character: null, messages: parseMessageArray(input) };
    }
    throw new Error('characterai 适配器：不支持的输入形态（期待 ZIP 字节/路径、三文件映射或 message.json 文本）');
}
/** 文件映射 → 三文件解析（键匹配按基名/去 .json 词干；值可为文本/字节/已解析） */
function filesFromMap(files) {
    const pick = (names) => {
        for (const key of Object.keys(files)) {
            const base = key.replace(/\\/g, '/').split('/').pop() ?? key;
            const stem = base.replace(/\.json$/i, '');
            if (names.includes(base) || names.includes(stem))
                return files[key];
        }
        return undefined;
    };
    return {
        user: toJsonObject(pick(['user.json', 'user'])),
        character: toJsonObject(pick(['character.json', 'character'])),
        messages: toMessageArray(pick(['message.json', 'message', 'messages.json', 'messages'])),
    };
}
function parseMaybeJson(v) {
    if (typeof v === 'string')
        return tryParseJson(v);
    if (v instanceof Uint8Array)
        return tryParseJson(decodeUtf8(v));
    return v;
}
function toJsonObject(v) {
    const parsed = parseMaybeJson(v);
    if (Array.isArray(parsed)) {
        // character.json 数组形态：取首个对象
        const first = parsed[0];
        return first !== null && typeof first === 'object' && !Array.isArray(first)
            ? first
            : null;
    }
    return parsed !== null && typeof parsed === 'object'
        ? parsed
        : null;
}
function toMessageArray(v) {
    const parsed = parseMaybeJson(v);
    return Array.isArray(parsed) ? parsed : [];
}
function parseMessageArray(text) {
    const parsed = tryParseJson(text);
    return Array.isArray(parsed) ? parsed : [];
}
function parseJsonObject(entry) {
    if (!entry)
        return null;
    return toJsonObject(decodeUtf8(entry.data));
}
/* ================================================================
 * 四、内部工具
 * ===============================================================*/
function pickString(obj, keys) {
    if (obj === null)
        return null;
    for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'string' && v.trim().length > 0)
            return v.trim();
    }
    return null;
}
function firstNonEmptyString(...values) {
    for (const v of values) {
        if (typeof v === 'string' && v.trim().length > 0)
            return v.trim();
    }
    return null;
}
/* ================================================================
 * 五、适配器对象
 * ===============================================================*/
export const characteraiAdapter = {
    name: 'characterai',
    label: 'Character.AI 官方导出',
    description: '官方导出 ZIP：<用户名>/data/{user,character,message}.json 三文件关联映射；消息文本取 raw_content 字段；is_human/说话人名推断角色',
    convert: (input) => adaptCharacterAI(input),
};
