/*
 * 传火（firelink）· 开源记忆加工内核 · 边缘 IO · Node 默认实现（37 施工案 T1）
 * Copyright (c) 2026 传火项目贡献者
 *
 * SPDX-License-Identifier: MIT
 *
 * 本文件是「传火」开源子集的一部分（议题 37 网页版施工案），按 MIT 许可证发布。
 * 开源边界：本目录自包含，不依赖任何闭源模块与 npm 外部依赖；
 * 本许可仅覆盖本开源组件；其余组件不受本许可约束。
 * 完整许可文本：https://opensource.org/licenses/MIT
 */
/**
 * Node 默认 IO 实现：原行为逐字搬移（37 案「npm 行为零改动」）。
 * 本文件是 node: 内置依赖在内核中的唯一集中地（npm 形态）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
export const nodeIO = {
    readTextFileSync: (path) => readFileSync(path, 'utf-8'),
    writeTextFileSync: (path, content) => writeFileSync(path, content, 'utf-8'),
    mkdirSync: (path) => mkdirSync(path, { recursive: true }),
    joinPath: join,
    env: () => process.env,
    base64Encode: (data) => Buffer.from(data).toString('base64'),
    sha256Hex: (text) => createHash('sha256').update(text, 'utf-8').digest('hex'),
    inflateRaw: async (data) => new Uint8Array(inflateRawSync(data)),
    readFileBytes: async (path) => new Uint8Array(await readFile(path)),
    readFileText: async (path) => await readFile(path, 'utf-8'),
};
