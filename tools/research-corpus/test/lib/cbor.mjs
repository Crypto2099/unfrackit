// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// A minimal CBOR decoder (RFC 8949) for reading transaction bodies in the
// integration tests: unsigned and negative integers, byte and text strings,
// arrays and maps (definite and indefinite), tags, simple values. Maps decode
// to Map so integer keys keep their type.

export function decodeCbor(buf) {
  let pos = 0;
  const u8 = buf;
  const readUint = (info) => {
    if (info < 24) return BigInt(info);
    const n = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : -1;
    if (n < 0) throw new Error(`bad additional info ${info}`);
    let v = 0n;
    for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(u8[pos++]);
    return v;
  };
  const item = () => {
    const b = u8[pos++];
    const major = b >> 5;
    const info = b & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 23) return undefined;
      if (info === 31) return BREAK;
      if (info === 25 || info === 26 || info === 27) {
        pos += info === 25 ? 2 : info === 26 ? 4 : 8;
        return NaN;
      }
      return { simple: info };
    }
    if (info === 31) {
      if (major === 2 || major === 3) {
        const parts = [];
        for (;;) {
          const p = item();
          if (p === BREAK) break;
          parts.push(p);
        }
        return major === 2 ? Buffer.concat(parts) : parts.join('');
      }
      if (major === 4) {
        const a = [];
        for (;;) {
          const x = item();
          if (x === BREAK) return a;
          a.push(x);
        }
      }
      if (major === 5) {
        const m = new Map();
        for (;;) {
          const k = item();
          if (k === BREAK) return m;
          m.set(norm(k), item());
        }
      }
      throw new Error('bad indefinite item');
    }
    const v = readUint(info);
    switch (major) {
      case 0:
        return v;
      case 1:
        return -1n - v;
      case 2: {
        const s = Buffer.from(u8.subarray(pos, pos + Number(v)));
        pos += Number(v);
        return s;
      }
      case 3: {
        const s = Buffer.from(u8.subarray(pos, pos + Number(v))).toString('utf8');
        pos += Number(v);
        return s;
      }
      case 4: {
        const a = [];
        for (let i = 0n; i < v; i++) a.push(item());
        return a;
      }
      case 5: {
        const m = new Map();
        for (let i = 0n; i < v; i++) {
          const k = item();
          m.set(norm(k), item());
        }
        return m;
      }
      case 6:
        return { tag: Number(v), value: item() };
      default:
        throw new Error(`major type ${major}`);
    }
  };
  const out = item();
  return out;
}

const BREAK = Symbol('break');
const norm = (k) => (typeof k === 'bigint' && k <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(k) : k);
const untag = (x) => (x && typeof x === 'object' && 'tag' in x ? x.value : x);

// The parts of a transaction the T9 test reads: [body, witnesses, is_valid, aux].
export function txParts(bytes) {
  const tx = decodeCbor(bytes);
  const body = tx[0];
  const ins = (k) => (untag(body.get(k)) || []).map(([h, i]) => `${h.toString('hex')}#${Number(i)}`);
  const coin = (out) => {
    if (out === undefined || out === null) return null;
    const value = out instanceof Map ? out.get(1) : out[1];
    return BigInt(Array.isArray(value) ? value[0] : value);
  };
  return {
    isValid: tx[2],
    inputs: ins(0),
    outputs: (body.get(1) || []).length,
    collateral: ins(13),
    collateralReturnCoin: coin(body.get(16)),
    totalCollateral: body.has(17) ? BigInt(body.get(17)) : null
  };
}
