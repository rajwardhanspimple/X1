/**
 * xxHash32 over raw bytes, using only Math.imul and unsigned shifts so the digest is identical
 * in every JavaScript engine.
 *
 * A StateHash is two passes with different seeds, concatenated: 64 bits of strength without
 * BigInt, which would be slower and is unnecessary here.
 */

const P1 = 0x9e3779b1;
const P2 = 0x85ebca77;
const P3 = 0xc2b2ae3d;
const P4 = 0x27d4eb2f;
const P5 = 0x165667b1;

function rotl(x: number, r: number): number {
  return ((x << r) | (x >>> (32 - r))) >>> 0;
}

export function xxhash32(bytes: Uint8Array, seed = 0): number {
  const len = bytes.length;
  let h: number;
  let i = 0;

  if (len >= 16) {
    let v1 = (seed + P1 + P2) | 0;
    let v2 = (seed + P2) | 0;
    let v3 = seed | 0;
    let v4 = (seed - P1) | 0;
    const limit = len - 16;
    while (i <= limit) {
      v1 = Math.imul(rotl((v1 + Math.imul(readU32(bytes, i), P2)) >>> 0, 13), P1);
      v2 = Math.imul(rotl((v2 + Math.imul(readU32(bytes, i + 4), P2)) >>> 0, 13), P1);
      v3 = Math.imul(rotl((v3 + Math.imul(readU32(bytes, i + 8), P2)) >>> 0, 13), P1);
      v4 = Math.imul(rotl((v4 + Math.imul(readU32(bytes, i + 12), P2)) >>> 0, 13), P1);
      i += 16;
    }
    h = (rotl(v1 >>> 0, 1) + rotl(v2 >>> 0, 7) + rotl(v3 >>> 0, 12) + rotl(v4 >>> 0, 18)) >>> 0;
  } else {
    h = (seed + P5) >>> 0;
  }

  h = (h + len) >>> 0;

  while (i + 4 <= len) {
    h = Math.imul(rotl((h + Math.imul(readU32(bytes, i), P3)) >>> 0, 17), P4) >>> 0;
    i += 4;
  }

  while (i < len) {
    h = Math.imul(rotl((h + Math.imul(bytes[i]!, P5)) >>> 0, 11), P1) >>> 0;
    i += 1;
  }

  h = Math.imul(h ^ (h >>> 15), P2) >>> 0;
  h = Math.imul(h ^ (h >>> 13), P3) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h >>> 0;
}

function readU32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}

/** 16 lowercase hex characters. */
export function hash64(bytes: Uint8Array): string {
  return hex8(xxhash32(bytes, 0)) + hex8(xxhash32(bytes, 0x9e3779b9));
}
