/*
 * 传火（firelink）· 开源记忆加工内核 · 边缘 IO · 环境分发（37 施工案 T1）
 * Copyright (c) 2026 传火项目贡献者
 *
 * SPDX-License-Identifier: MIT
 *
 * 本文件是「传火」开源子集的一部分（议题 37 网页版施工案），按 MIT 许可证发布。
 * 开源边界：本目录自包含，不依赖任何闭源模块与 npm 外部依赖；
 * 本许可仅覆盖本开源组件；其余组件不受本许可约束。
 * 完整许可文本：https://opensource.org/licenses/MIT
 */
const isNode = typeof process === 'object' &&
    process !== null &&
    typeof process.versions?.node === 'string';
let impl;
if (isNode) {
    impl = (await import('./io-node.js')).nodeIO;
}
else {
    impl = (await import('./io-browser.js')).browserIO;
}
/** 当前运行环境的边缘 IO 实现（Node 默认 / 浏览器注入） */
export const firelinkIO = impl;
