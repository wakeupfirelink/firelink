/*
 * 传火（firelink）· 开源记忆加工内核 · L0 适配器 · ChatGPT 官方导出
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
 * L0 适配器：ChatGPT 官方 conversations.json（36 施工案 36.2）
 * ---------------------------------------------------------------
 * mapping 消息树遍历 → 线性序列：
 * - tree 模式（默认）：从根节点（parent=null）DFS 前序遍历 children 链，
 *   还原对话线性顺序；用户重 roll 的旁支按出现顺序入列（供 L1 去重复核）
 * - current-path 模式：从 current_node 沿 parent 回溯到根，只取当前主路径
 * - author.role：user→user / assistant→assistant / system→system / tool→跳过
 * - content.parts 取字符串项拼接；空文本消息（空 system / 附件占位）跳过
 * - create_time（epoch 秒）→ epoch ms
 * 输入：conversations.json 文本 / 已解析对象 / 文件路径。
 */
import { buildL0Result, epochToMs, resolveInputText, tryParseJson, } from './common.js';
/* ================================================================
 * 二、主转换
 * ===============================================================*/
export async function adaptChatGPT(input, options = {}) {
    const text = await resolveInputText(input, 'chatgpt');
    const parsed = tryParseJson(text);
    const conversations = extractConversations(parsed);
    if (conversations.length === 0) {
        throw new Error('chatgpt 适配器：未识别到会话数据（期待官方导出 conversations.json：含 mapping 的会话数组）');
    }
    const mode = options.chatgptMode ?? 'tree';
    const messages = [];
    let skipped = 0;
    conversations.forEach((conv, conversationIndex) => {
        const linear = mode === 'current-path' ? currentPathMessages(conv) : treeLinearMessages(conv);
        for (const msg of linear) {
            const extracted = extractMessage(msg);
            if (extracted === null) {
                skipped++;
                continue;
            }
            messages.push({
                role: extracted.role,
                text: extracted.text,
                ts: extracted.ts,
                meta: {
                    source: 'chatgpt',
                    conversationTitle: conv.title ?? null,
                    conversationIndex,
                    ...(extracted.originalRole !== undefined
                        ? { originalRole: extracted.originalRole }
                        : {}),
                },
            });
        }
    });
    return buildL0Result(messages, {
        skipped,
        meta: {
            adapter: 'chatgpt',
            conversations: conversations.length,
            mode,
            skipped,
        },
    });
}
/* ================================================================
 * 三、会话提取与消息树遍历
 * ===============================================================*/
function extractConversations(parsed) {
    if (Array.isArray(parsed))
        return parsed.filter(isConversation);
    if (parsed !== null && typeof parsed === 'object') {
        const obj = parsed;
        if (Array.isArray(obj.conversations)) {
            return obj.conversations.filter(isConversation);
        }
        if (isConversation(obj))
            return [obj];
    }
    return [];
}
function isConversation(v) {
    return (typeof v === 'object' &&
        v !== null &&
        'mapping' in v &&
        typeof v.mapping === 'object' &&
        v.mapping !== null);
}
/** tree 模式：根节点 DFS 前序遍历（对象引用去重防环） */
function treeLinearMessages(conv) {
    const mapping = conv.mapping ?? {};
    const out = [];
    const seen = new Set();
    const visit = (node) => {
        if (seen.has(node))
            return;
        seen.add(node);
        if (node.message)
            out.push(node.message);
        for (const childId of node.children ?? []) {
            const child = mapping[childId];
            if (child)
                visit(child);
        }
    };
    for (const node of Object.values(mapping)) {
        if (node.parent === null || node.parent === undefined)
            visit(node);
    }
    return out;
}
/** current-path 模式：current_node 沿 parent 回溯到根后反转 */
function currentPathMessages(conv) {
    const mapping = conv.mapping ?? {};
    const path = [];
    const seen = new Set();
    let cursor = conv.current_node ? mapping[conv.current_node] : undefined;
    while (cursor !== undefined && cursor !== null && !seen.has(cursor)) {
        seen.add(cursor);
        if (cursor.message)
            path.push(cursor.message);
        cursor = cursor.parent ? mapping[cursor.parent] : undefined;
    }
    return path.reverse();
}
function extractMessage(msg) {
    const role = msg.author?.role;
    if (role === 'tool')
        return null; // 工具调用消息（内部 CoT 产物，不入记忆）
    const parts = msg.content?.parts;
    const text = Array.isArray(parts)
        ? parts
            .filter((p) => typeof p === 'string')
            .map((p) => p.trim())
            .filter((p) => p.length > 0)
            .join('\n')
        : '';
    if (text.length === 0)
        return null; // 空 system / 纯附件占位
    const mapped = role === 'user'
        ? 'user'
        : role === 'assistant'
            ? 'assistant'
            : role === 'system'
                ? 'system'
                : null;
    return {
        role: mapped ?? 'unlabeled',
        text,
        ts: epochToMs(msg.create_time ?? null),
        ...(mapped === null && role !== undefined ? { originalRole: role } : {}),
    };
}
/* ================================================================
 * 五、适配器对象
 * ===============================================================*/
export const chatgptAdapter = {
    name: 'chatgpt',
    label: 'ChatGPT 官方导出',
    description: '官方 conversations.json（会话数组，mapping 消息树遍历→线性序列；tool 与空消息跳过；create_time 秒→ms）',
    convert: (input, options) => adaptChatGPT(input, options),
};
