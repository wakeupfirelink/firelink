/*
 * 传火（firelink）· 开源记忆加工内核 · 纯 JS SHA-256（37 施工案 T1）
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
 * 纯 JS 同步 SHA-256（hex 输出，与 node:crypto createHash('sha256') 逐位一致）
 * ---------------------------------------------------------------
 * 为何不用 crypto.subtle.digest：它是异步的，而 clean.ts 的去重指纹
 * （cleanSegments）是同步链路。为保持内核同步语义零改动，浏览器版
 * 内嵌此同步实现。标准算法（FIPS 180-4），无外部依赖。
 */
const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const H0 = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
/** 32 位循环右移 */
function rotr(x, n) {
    return ((x >>> n) | (x << (32 - n))) >>> 0;
}
/** SHA-256（hex 小写输出；与 node:crypto 一致） */
export function sha256Hex(text) {
    const msg = new TextEncoder().encode(text);
    const bitLenHi = Math.floor((msg.length / 0x20000000)) >>> 0; // 高 32 位（length*8 >>> 32）
    const bitLenLo = (msg.length << 3) >>> 0; // 低 32 位
    // 填充：msg + 0x80 + 零 + 8 字节大端位长，总长 64 的倍数
    const paddedLen = (((msg.length + 9 + 63) >> 6) << 6) >>> 0;
    const block = new Uint8Array(paddedLen);
    block.set(msg);
    block[msg.length] = 0x80;
    const view = new DataView(block.buffer);
    view.setUint32(paddedLen - 8, bitLenHi, false);
    view.setUint32(paddedLen - 4, bitLenLo, false);
    let h0 = H0[0], h1 = H0[1], h2 = H0[2], h3 = H0[3];
    let h4 = H0[4], h5 = H0[5], h6 = H0[6], h7 = H0[7];
    const w = new Uint32Array(64);
    for (let off = 0; off < paddedLen; off += 64) {
        for (let i = 0; i < 16; i++)
            w[i] = view.getUint32(off + i * 4, false);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }
        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0;
        h5 = (h5 + f) >>> 0;
        h6 = (h6 + g) >>> 0;
        h7 = (h7 + h) >>> 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7]
        .map((x) => x.toString(16).padStart(8, '0'))
        .join('');
}
