/*
 * 传火（firelink）· 开源记忆加工内核 · L0 适配器 · 闭源平台导出（接入位）
 * Copyright (c) 2026 传火项目贡献者
 *
 * SPDX-License-Identifier: MIT
 *
 * 本文件是「传火」开源子集的一部分（议题 36 施工案 36.2），按 MIT 许可证发布。
 * 开源边界：本目录（open/adapters/）自包含——仅依赖 open/ 内组件与 node: 内置，
 * 零 npm 外部依赖、零闭源依赖；本许可仅覆盖本开源组件，其余组件不受本许可约束。
 * 完整许可文本：https://opensource.org/licenses/MIT
 */
/* ================================================================
 * 一、接入位专用错误
 * ===============================================================*/
/** 接入位未实现错误（调用方可按 name 识别并给出引导文案） */
export class NotImplementedError extends Error {
    adapterName;
    constructor(adapterName, message) {
        super(message);
        this.name = 'NotImplementedError';
        this.adapterName = adapterName;
    }
}
/* ================================================================
 * 三、适配器对象（占位）
 * ===============================================================*/
export const qqExportAdapter = {
    name: 'qq-export',
    label: '闭源平台导出（接入位）',
    description: '闭源导出格式适配接入位：接口声明+注册表占位，实现随 P1 施工落地',
    status: 'not-implemented',
    async convert(_input) {
        throw new NotImplementedError('qq-export', 'qq-export 适配器未实现：本棒只交付接入位（接口声明+注册表占位），实现随 P1 施工落地');
    },
};
