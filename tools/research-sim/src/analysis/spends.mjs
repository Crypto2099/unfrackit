// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// One run's spend rows held in columns. A built spend costs about 29 bytes in
// typed arrays where one object per row cost about 190. The table answers the
// Map calls the computations make on `run.spends` (get, has, size, keys,
// values, entries, iteration, forEach) and builds a row object only when a
// caller asks for it, with the keys and values the reader used to store. A row
// the columns cannot hold exactly (any outcome but built, a type that is not a
// string, a value outside a column's range) is kept as the object itself.

const TYPE_LIMIT = 0xffff;
const types = [];
const typeIds = new Map();
const typeId = (t) => {
  if (typeof t !== 'string') return -1;
  let id = typeIds.get(t);
  if (id === undefined) {
    if (types.length >= TYPE_LIMIT) return -1;
    id = types.length;
    types.push(t);
    typeIds.set(t, id);
  }
  return id;
};

const NONE = -1;

class Rows {
  intentAt(i) {
    return this.kind[i] === 1 ? this.objects.get(i).intent : this.intent[i];
  }

  // The row index of an intent, or -1.
  find(intent) {
    let lo = 0;
    let hi = this.size - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = this.intentAt(mid);
      if (v === intent) return mid;
      if (v < intent) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  get(intent) {
    const i = this.find(intent);
    return i < 0 ? undefined : this.row(i);
  }

  has(intent) {
    return this.find(intent) >= 0;
  }

  *values() {
    for (let i = 0; i < this.size; i++) yield this.row(i);
  }

  *keys() {
    for (let i = 0; i < this.size; i++) yield this.intentAt(i);
  }

  *entries() {
    for (let i = 0; i < this.size; i++) yield [this.intentAt(i), this.row(i)];
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  // A view of the rows `keep` accepts, in order: one index per kept row over the same columns.
  filter(keep) {
    const mask = new Uint8Array(this.size);
    let n = 0;
    for (let i = 0; i < this.size; i++) {
      if (keep(this.row(i))) {
        mask[i] = 1;
        n++;
      }
    }
    const idx = new Uint32Array(n);
    let j = 0;
    for (let i = 0; i < this.size; i++) if (mask[i]) idx[j++] = this.rootIndex(i);
    return new SpendView(this.root(), idx);
  }

  forEach(fn, thisArg) {
    for (const [k, s] of this.entries()) fn.call(thisArg, s, k, this);
  }
}

export class SpendTable extends Rows {
  // `capacity` is the most rows the table will be given.
  constructor(capacity) {
    super();
    this.size = 0;
    this.intent = new Int32Array(capacity);
    this.type = new Uint16Array(capacity);
    this.txs = new Uint16Array(capacity);
    this.spendable = new Int32Array(capacity);
    this.fee = new BigInt64Array(capacity);
    this.walletFee = new BigInt64Array(capacity);
    // 0 for a built row held in the columns, 1 for a row held as an object.
    this.kind = new Uint8Array(capacity);
    this.objects = new Map();
  }

  // Add a row (intents ascending, as the reader checks).
  add(s) {
    const i = this.size++;
    const intentFits = Number.isInteger(s.intent) && s.intent >= -2147483648 && s.intent <= 2147483647;
    const id = s.outcome === 'built' ? typeId(s.type) : -1;
    const hasSpendable = s.spendable !== undefined;
    const fits =
      id >= 0 &&
      intentFits &&
      Number.isInteger(s.txs) && s.txs >= 0 && s.txs <= 0xffff &&
      typeof s.fee === 'bigint' && BigInt.asIntN(64, s.fee) === s.fee &&
      typeof s.walletFee === 'bigint' && BigInt.asIntN(64, s.walletFee) === s.walletFee &&
      s.chained === s.txs > 1 &&
      (!hasSpendable || (Number.isInteger(s.spendable) && s.spendable >= 0 && s.spendable <= 2147483647)) &&
      Object.keys(s).length === (hasSpendable ? 8 : 7);
    if (!fits) {
      this.kind[i] = 1;
      this.objects.set(i, s);
      return;
    }
    this.intent[i] = s.intent;
    this.type[i] = id;
    this.txs[i] = s.txs;
    this.spendable[i] = hasSpendable ? s.spendable : NONE;
    this.fee[i] = s.fee;
    this.walletFee[i] = s.walletFee;
  }

  row(i) {
    if (this.kind[i] === 1) return this.objects.get(i);
    const txs = this.txs[i];
    const s = { intent: this.intent[i], type: types[this.type[i]], outcome: 'built', txs, chained: txs > 1, fee: this.fee[i], walletFee: this.walletFee[i] };
    if (this.spendable[i] !== NONE) s.spendable = this.spendable[i];
    return s;
  }

  row(i) {
    if (this.kind[i] === 1) return this.objects.get(i);
    const txs = this.txs[i];
    const s = { intent: this.intent[i], type: types[this.type[i]], outcome: 'built', txs, chained: txs > 1, fee: this.fee[i], walletFee: this.walletFee[i] };
    if (this.spendable[i] !== NONE) s.spendable = this.spendable[i];
    return s;
  }

  root() {
    return this;
  }

  rootIndex(i) {
    return i;
  }
}

// The rows of a table that a filter kept, by index into it.
class SpendView extends Rows {
  constructor(table, idx) {
    super();
    this.table = table;
    this.idx = idx;
    this.size = idx.length;
  }

  row(i) {
    return this.table.row(this.idx[i]);
  }

  intentAt(i) {
    return this.table.intentAt(this.idx[i]);
  }

  root() {
    return this.table;
  }

  rootIndex(i) {
    return this.idx[i];
  }
}
