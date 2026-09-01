/**
 * 记忆引擎内核 36.2 · L0 适配器测试共享工具
 * ---------------------------------------------------------------
 * - makeZip：内存构造 ZIP（stored 方式，零依赖手写本地头/中央目录/EOCD），
 *   用于构造 Character.AI 导出 ZIP 与 docx fixture（真实解压路径全覆盖）
 * - makeDocx：内存构造最小 docx（word/document.xml + [Content_Types].xml）
 * - MockVisionProvider：多模态转写 mock（单测一律 mock，禁止调真实 API）
 * - fakePngBytes：构造 PNG 魔数假图片（无真实图片内容）
 * 施工纪律：LLM 单测一律 mock provider，禁止调真实 API；敏感字段一律假数据。
 */

import type {
  MultimodalProvider,
  MultimodalTranscribeRequest,
} from '../src/adapters/common.js';

/* ================================================================
 * 一、CRC32 + ZIP 构造器（stored，不压缩）
 * ===============================================================*/

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 内存构造 ZIP（method 0 stored；本地头 + 中央目录 + EOCD，30/46/22 字节布局） */
export function makeZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (b: Uint8Array): void => {
    chunks.push(b);
    offset += b.length;
  };
  const u16 = (v: number): Uint8Array => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v: number): Uint8Array =>
    new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

  const central: Array<{ name: Uint8Array; data: Uint8Array; crc: number; localOffset: number }> = [];
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data = typeof content === 'string' ? encoder.encode(content) : content;
    const crc = crc32(data);
    const localOffset = offset;
    push(u32(0x04034b50)); // 本地文件头签名
    push(u16(20)); // 版本
    push(u16(0)); // flags
    push(u16(0)); // method: stored
    push(u16(0)); // 修改时间
    push(u16(0)); // 修改日期
    push(u32(crc));
    push(u32(data.length));
    push(u32(data.length));
    push(u16(nameBytes.length));
    push(u16(0)); // extra 长
    push(nameBytes);
    push(data);
    central.push({ name: nameBytes, data, crc, localOffset });
  }

  const cdStart = offset;
  for (const e of central) {
    push(u32(0x02014b50)); // 中央目录签名
    push(u16(20)); // 制作版本
    push(u16(20)); // 需要版本
    push(u16(0)); // flags
    push(u16(0)); // method
    push(u16(0));
    push(u16(0));
    push(u32(e.crc));
    push(u32(e.data.length));
    push(u32(e.data.length));
    push(u16(e.name.length));
    push(u16(0)); // extra
    push(u16(0)); // comment
    push(u16(0)); // disk
    push(u16(0)); // 内部属性
    push(u32(0)); // 外部属性
    push(u32(e.localOffset));
    push(e.name);
  }
  const cdSize = offset - cdStart;
  push(u32(0x06054b50)); // EOCD 签名
  push(u16(0));
  push(u16(0));
  push(u16(central.length));
  push(u16(central.length));
  push(u32(cdSize));
  push(u32(cdStart));
  push(u16(0)); // 尾注长

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/* ================================================================
 * 二、docx 构造器（最小 OOXML）
 * ===============================================================*/

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 构造最小 docx：每段落一个 <w:p>（文本 XML 转义） */
export function makeDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`)
    .join('');
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`;
  return makeZip({
    'word/document.xml': document,
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types/>',
  });
}

/* ================================================================
 * 三、多模态转写 mock
 * ===============================================================*/

export type VisionMockHandler = (req: MultimodalTranscribeRequest, callIndex: number) => string;

/** 可编程多模态 mock（记录调用，返回固定/可编程文本） */
export class MockVisionProvider implements MultimodalProvider {
  readonly name = 'mock-vision';
  readonly calls: MultimodalTranscribeRequest[] = [];
  private readonly handler: VisionMockHandler;

  constructor(handler?: VisionMockHandler) {
    this.handler = handler ?? (() => '[]');
  }

  transcribe(req: MultimodalTranscribeRequest): Promise<string> {
    this.calls.push(req);
    return Promise.resolve(this.handler(req, this.calls.length - 1));
  }
}

/* ================================================================
 * 四、假图片字节（PNG 魔数 + 伪载荷）
 * ===============================================================*/

export function fakePngBytes(payload = 'fake-png-payload'): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(payload)]);
}

export function fakeJpegBytes(payload = 'fake-jpeg-payload'): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(payload)]);
}
