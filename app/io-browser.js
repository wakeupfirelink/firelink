/*
 * 传火（firelink）· 开源记忆加工内核 · 边缘 IO · 浏览器实现（37 施工案 T1）
 * Copyright (c) 2026 传火项目贡献者
 *
 * SPDX-License-Identifier: MIT
 *
 * 本文件是「传火」开源子集的一部分（议题 37 网页版施工案），按 MIT 许可证发布。
 * 开源边界：本目录自包含，不依赖任何闭源模块与 npm 外部依赖、零 node: 内置；
 * 本许可仅覆盖本开源组件；其余组件不受本许可约束。
 * 完整许可文本：https://opensource.org/licenses/MIT
 */
/**
 * 浏览器 IO 实现（37 施工案 T1）：
 * - 路径读取 / 落盘：不支持（网页形态走文件选择器 + Blob 下载），抛中文指引错误
 * - env：恒空对象（BYO key 由 UI 直接构造 provider 注入，不走环境变量）
 * - base64：btoa 分块（避免超长参数栈溢出）
 * - sha256：纯 JS 同步实现（src/sha256.ts，与 Node 输出逐位一致）
 * - inflateRaw：DecompressionStream('deflate-raw')（Chrome 103+ / Safari 16.4+ / Firefox 113+）
 */
import { sha256Hex } from './sha256.js';
/** 不支持能力的统一错误（附浏览器形态的替代路径指引） */
function unsupported(what, hint) {
    throw new Error(`浏览器版不支持${what}。${hint}`);
}
export const browserIO = {
    readTextFileSync: (_path) => {
        unsupported('从文件路径读取规则配置', '网页版规则配置通过页面设置项传入（见产品文档）');
    },
    writeTextFileSync: (_path, _content) => {
        unsupported('写文件到磁盘', '网页版产物通过浏览器下载（Blob）交付');
    },
    mkdirSync: (_path) => {
        unsupported('创建目录', '网页版产物通过浏览器下载（Blob）交付');
    },
    joinPath: (dir, rest) => `${dir.replace(/\/+$/, '')}/${rest}`,
    env: () => ({}),
    base64Encode: (data) => {
        // 分块拼接二进制串（String.fromCharCode 参数上限保护）
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < data.length; i += CHUNK) {
            binary += String.fromCharCode(...data.subarray(i, i + CHUNK));
        }
        return btoa(binary);
    },
    sha256Hex,
    inflateRaw: async (data) => {
        if (typeof DecompressionStream === 'undefined') {
            unsupported('deflate 解压（当前浏览器缺少 DecompressionStream）', '请使用较新的浏览器（Chrome 103+ / Safari 16.4+ / Firefox 113+）');
        }
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const buf = await new Response(stream).arrayBuffer();
        return new Uint8Array(buf);
    },
    readFileBytes: async (_path) => {
        unsupported('从文件路径读取', '网页版请用文件选择器上传文件内容');
    },
    readFileText: async (_path) => {
        unsupported('从文件路径读取', '网页版请用文件选择器或粘贴文本');
    },
};
