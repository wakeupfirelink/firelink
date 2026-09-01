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

/**
 * L0 适配器：闭源平台导出（接入位，36 施工案 36.2 拍板）
 * ---------------------------------------------------------------
 * 本棒只交付接入位：接口声明 + 统一注册表占位 + 明确 throw NotImplemented。
 * 闭源导出格式的实现随 P1 施工落地（十月经办），本文件不实现任何解析逻辑。
 */

import type { L0Adapter, L0Input, L0Result } from './common.js';

/* ================================================================
 * 一、接入位专用错误
 * ===============================================================*/

/** 接入位未实现错误（调用方可按 name 识别并给出引导文案） */
export class NotImplementedError extends Error {
  readonly adapterName: string;

  constructor(adapterName: string, message: string) {
    super(message);
    this.name = 'NotImplementedError';
    this.adapterName = adapterName;
  }
}

/* ================================================================
 * 二、接入位接口声明（P1 施工契约，本棒不实现）
 * ===============================================================*/

/** 闭源导出内容的输入形态（P1 契约预留：HTML/TXT/JSON 等格式随实现落地） */
export interface ClosedPlatformExportInput {
  /** 导出内容 */
  content: string | Uint8Array;
  /** 可选伴随文件（元信息/索引等，随 P1 格式细则确定） */
  extras?: Record<string, string | Uint8Array>;
}

/** P1 实现方须满足的接入契约（对接入位的行为约定） */
export interface ClosedPlatformExportContract {
  /** 注册表名（固定 'qq-export'） */
  readonly name: 'qq-export';
  /** P1 施工完成后 convert 输出与其他 L0 适配器同构（统一 schema） */
  convert(input: L0Input): Promise<L0Result>;
}

/* ================================================================
 * 三、适配器对象（占位）
 * ===============================================================*/

export const qqExportAdapter: L0Adapter = {
  name: 'qq-export',
  label: '闭源平台导出（接入位）',
  description: '闭源导出格式适配接入位：接口声明+注册表占位，实现随 P1 施工落地',
  status: 'not-implemented',
  async convert(_input: L0Input): Promise<L0Result> {
    throw new NotImplementedError(
      'qq-export',
      'qq-export 适配器未实现：本棒只交付接入位（接口声明+注册表占位），实现随 P1 施工落地',
    );
  },
};
