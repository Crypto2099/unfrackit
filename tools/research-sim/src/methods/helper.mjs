// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The bridge: a method whose library runs in another language, in a helper
// process, with the same contract as a JavaScript adapter (methods/
// contract.mjs). The helper builds the transaction with its library; this
// module does what every adapter does after its library returns: it reads the
// wallet inputs from the transaction's bytes, has the synthetic vkey witnesses
// written (library.mjs), and under changePolicy 'layout' drops the library's
// change and builds UnFrack.It's change on those inputs through change.mjs,
// the kit assembling the transaction at its exact fee with the intent's fixed
// parts and the collateral the engine set aside, as for the JavaScript
// libraries that build whole transactions. The helper never knows the change
// policy. A library that fails to build fails under both policies alike.
//
// Process. One helper process per helper method per process that builds (a
// pool worker, or the process that runs a replay itself), started on the
// method's first build and stopped with that process: on its exit, and, when
// the process is killed, by the end of input the helper then reads, on which
// every helper exits. Requests and responses are one JSON object per line on
// the helper's stdin and stdout, one request at a time; its stderr goes to
// this process's stderr (a worker's log) and its last 4 KiB are kept. While no
// request is waiting the process and its pipes are unreferenced, so they never
// keep this process alive. A helper that exits, writes a line that is not the
// response to the waiting request, or whose input closes, is a run error
// (contract.mjs RunError): the job stops with the helper's stderr tail, never
// with a spend outcome. No time limit is set on a request: a helper that stops
// answering holds its job until the pool's watchdog stops the worker
// (replay/pool.mjs), which reruns the job and records nothing of the stopped
// attempt.
//
// Schema 1. Every value the ledger encodes is CBOR as lowercase hex; every
// integer the ledger holds is a decimal string; a rational is a pair of
// decimal strings.
//   build request
//     { op: 'build', schema: 1, id, library,
//       network       the run's network: 'mainnet', 'preprod' or 'synthetic'
//       networkId     the change address's network id (0 or 1)
//       at            { slot, time } the spend's slot and block time, or nulls
//       stakeCred     the wallet's stake credential (hex)
//       changeAddress bech32
//       utxos         the wallet's spendable UTxOs in the state's order
//                     (library.mjs inputOrder), the intent's fixed inputs left
//                     out: [{ ref ('txid#index'), cbor? }], cbor the
//                     TransactionUnspentOutput [input, output]. cbor is left
//                     out for a reference this helper process has already been
//                     sent with the same bytes; the helper keeps every
//                     reference's bytes it is sent until it exits
//       outputs       the requested outputs, each its TransactionOutput bytes
//       params        the run's protocol parameters (kit/params.mjs): minFeeA,
//                     minFeeB, coinsPerUtxoByte, maxValSize, maxTxSize,
//                     maxCollateralInputs, collateralPercent, priceMem,
//                     priceStep, minFeeRefScriptCostPerByte, keyDeposit,
//                     poolDeposit, drepDeposit, govActionDeposit, network,
//                     epoch, protocolMajor; null where the run states none
//       seed          a 64-bit seed as a decimal string, for a library that
//                     draws at random, or null
//       intent        { id, source ('replay' for a replayed intent),
//                     collateralRequired (boolean),
//                     implicit { withdrawals, refunds, deposits, donation,
//                       mint [{ policy, name, qty }], burn [...] },
//                     fixed: null, or the replay's fixed parts:
//                       inputs [{ ref, cbor, walletKey?, held? }]  fixed
//                         inputs with their outputs (other parties' and
//                         script inputs, the wallet's held UTxOs it spends)
//                       referenceInputs [{ ref, cbor }]
//                       body { <field>: hex }  the body fields 3 (TTL), 4
//                         (certificates), 5 (withdrawals), 8 (validity start),
//                         9 (mint), 14 (required signers), 19 (votes), 20
//                         (proposals), 21 (current treasury value), 22
//                         (donation), each as its original bytes
//                       witnesses { <key>: hex }  the witness set's entries
//                         other than the wallet's own vkey witnesses: 0 other
//                         vkey witnesses, 1 native scripts, 2 bootstrap
//                         witnesses, 3, 6, 7 Plutus V1 to V3 scripts, 4 datums,
//                         5 redeemers
//                       redeemers [{ tag, target, data, exUnits [mem, steps] }]
//                         with the part each redeems (kit/replay.mjs
//                         targetKey)
//                       auxiliaryData  hex or null
//                       scriptFee, fixedBytes, refScriptBytes }
//       collateral    { ref, cbor }: the UTxO the engine set aside for a script
//                     spend, or null }
//   witness request, after a build that succeeded
//     { op: 'witness', schema: 1, id, vkeys [hex], observed }
//       vkeys: the transaction's vkey witnesses, each [vkey, signature] as
//       bytes: one synthetic witness per wallet key (kit/replay.mjs
//       replayWitnessKeys, syntheticVkeys), then the intent's other vkey
//       witnesses as observed, the last `observed` of them. The helper
//       writes them into the witness set of the transaction it last built, in
//       its library's encoding, in place of any vkey witnesses it holds, and
//       returns the transaction, with unpriced ['observed vkey witnesses']
//       when they outnumber the witnesses its library's fee priced.
//   response
//     { id, ok: true, tx (hex), unpriced? [names] }
//       unpriced: the parts the helper wrote on the transaction after its
//       library priced it (the engine names them in a failed check's detail)
//     { id, ok: false, error (the library's error text), stage?,
//       notReplayable? (the part the library has no way to express),
//       class? (a failure class of kit/check.mjs, when the helper's adapter
//       has classified the error itself) }
//       stage names where the build failed ('requested output', 'replay
//       parts', or the library's call) and starts the failure's detail; an
//       unclassified error is classified by the method's own table.
//     { id, ok: false, error, stage?, class?, inputs [ref] }
//       inputs: for a library whose selection is a call of its own made
//       before its change (cardano-serialization-lib's add_inputs_from), the
//       wallet inputs it selected when a later step failed. Under 'layout'
//       the bridge builds UnFrack.It's change on them, as that library's
//       JavaScript adapter does (csl.mjs); under 'default' the failure stands.
//       A helper whose library selects and makes its change in one call
//       never sends it, and its failure stands under both policies.
//
// Identity. A helper is built by scripts/build-helpers.mjs <name> from its
// source under helpers/<name>/ into build/helpers/<name>/ (gitignored), with a
// build record (BUILD_RECORD) of the source files' SHA-256, the toolchain and
// the executable's SHA-256. A helper method refuses to load when the record is
// missing, its source hash differs from the source in the tree, or the
// executable's hash differs from the record, naming the command that builds
// it; its version names the library and the executable's hash, so a run's
// code manifest records which helper built it.
//
// Memory. The pool's memory readings of a worker (replay/pool.mjs
// processMemory) count its child processes, so the budget sees a worker and
// its helpers together.

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLASSES } from '../kit/check.mjs';
import { inspectTx } from '../kit/inspect.mjs';
import { replayRefusal, listItems, replayWitnessKeys, syntheticVkeys } from '../kit/replay.mjs';
import { minFee } from '../kit/fee.mjs';
import { paramsJson } from '../kit/params.mjs';
import { addressBytes } from '../history/address.mjs';
import { NOT_REPLAYABLE, RESULT_CLASSES, RunError } from './contract.mjs';
import { buildWithChange } from './change.mjs';
import { inputOrder, recordsOf, refuseUncovered, txRecord } from './library.mjs';

export const HELPER_SCHEMA = 1;
export const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HELPER_SOURCE_DIR = 'helpers';
export const HELPER_BUILD_DIR = 'build/helpers';
export const BUILD_RECORD = 'build.json';
export const BUILD_SCRIPT = 'scripts/build-helpers.mjs';

const TAIL_BYTES = 4096;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---- Helper builds.

// The files of a helper's source directory, relative to it, sorted.
export function helperSourceFiles(name, tool = TOOL) {
  const root = join(tool, HELPER_SOURCE_DIR, name);
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(root, p));
    }
  };
  walk(root);
  return out.sort();
}

// The SHA-256 of a helper's source: of each file's path and SHA-256, in path
// order.
export function helperSourceHash(name, tool = TOOL) {
  const root = join(tool, HELPER_SOURCE_DIR, name);
  const h = createHash('sha256');
  for (const f of helperSourceFiles(name, tool)) h.update(`${f}\0${sha256(readFileSync(join(root, f)))}\0`);
  return h.digest('hex');
}

// Why helper `name`'s build cannot be used, or null; and its record.
export function helperBuild(name, tool = TOOL) {
  const hint = `run node ${BUILD_SCRIPT} ${name} in ${tool}`;
  const dir = join(tool, HELPER_BUILD_DIR, name);
  const recFile = join(dir, BUILD_RECORD);
  if (!existsSync(join(tool, HELPER_SOURCE_DIR, name))) return { problem: `there is no helper ${name} under ${HELPER_SOURCE_DIR}/`, record: null };
  if (!existsSync(recFile)) return { problem: `the ${name} helper is not built (${join(HELPER_BUILD_DIR, name, BUILD_RECORD)} is missing); ${hint}`, record: null };
  let rec;
  try {
    rec = JSON.parse(readFileSync(recFile, 'utf8'));
  } catch (e) {
    return { problem: `the ${name} helper's build record cannot be read (${e.message}); ${hint}`, record: null };
  }
  const differs = [];
  if (rec.name !== name) differs.push(`its name ${rec.name}`);
  if (rec.schema !== HELPER_SCHEMA) differs.push(`schema ${rec.schema}, the bridge's ${HELPER_SCHEMA}`);
  if (rec.sourceHash !== helperSourceHash(name, tool)) differs.push(`the source under ${HELPER_SOURCE_DIR}/${name}`);
  const exe = rec.executable ? join(dir, rec.executable) : null;
  if (!exe || !existsSync(exe) || !statSync(exe).isFile() || sha256(readFileSync(exe)) !== rec.sha256) differs.push('the executable\'s SHA-256');
  if (differs.length) return { problem: `the ${name} helper's build differs from the tree (${differs.join('; ')}); ${hint}`, record: rec };
  return { problem: null, record: Object.freeze({ ...rec, path: exe }) };
}

// ---- Helper processes.

// A helper process speaking schema 1; one request at a time.
class HelperProcess {
  constructor({ key, command, args = [], env = process.env }) {
    this.key = key;
    this.tail = '';
    this.buf = '';
    this.waiting = null;
    this.dead = null;
    this.seq = 0;
    // The bytes of each reference this process has been sent.
    this.sent = new Map();
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.pid = child.pid;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => this.data(d));
    child.stderr.on('data', (d) => {
      process.stderr.write(d);
      this.tail = (this.tail + d.toString('utf8')).slice(-TAIL_BYTES);
    });
    child.on('error', (e) => this.fail(`could not be run (${e.message})`));
    child.on('close', (code, signal) => this.fail(signal ? `was killed by ${signal}` : `exited with code ${code}`));
    child.stdin.on('error', (e) => this.fail(`its input closed (${e.message})`));
    this.idle();
  }

  handles() {
    return [this.child, this.child.stdin, this.child.stdout, this.child.stderr].filter((h) => h && typeof h.unref === 'function');
  }

  idle() {
    for (const h of this.handles()) h.unref();
  }

  busy() {
    for (const h of this.handles()) h.ref();
  }

  error(why) {
    const tail = this.tail.trim();
    return new RunError(`helper ${this.key} (pid ${this.pid}) ${why}${tail ? `; its stderr ends: ${tail}` : '; its stderr is empty'}`);
  }

  fail(why) {
    if (this.dead) return;
    this.dead = why;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        // gone
      }
    }
    const w = this.waiting;
    this.waiting = null;
    this.idle();
    if (w) w.reject(this.error(why));
  }

  data(d) {
    this.buf += d;
    for (;;) {
      const nl = this.buf.indexOf('\n');
      if (nl < 0) return;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.line(line);
    }
  }

  line(text) {
    if (this.dead) return;
    const w = this.waiting;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      msg = null;
    }
    if (!w || !msg || typeof msg !== 'object' || msg.id !== w.id || typeof msg.ok !== 'boolean') {
      this.fail(`wrote a line that is not the response to request ${w ? w.id : '(none waiting)'}: ${text.slice(0, 200)}`);
      return;
    }
    this.waiting = null;
    this.idle();
    w.resolve(msg);
  }

  request(msg) {
    if (this.dead) return Promise.reject(this.error(this.dead));
    if (this.waiting) return Promise.reject(new Error(`helper ${this.key}: a request is already waiting`));
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.waiting = { id, resolve: res, reject: rej };
      this.busy();
      this.child.stdin.write(`${JSON.stringify({ ...msg, schema: HELPER_SCHEMA, id })}\n`);
    });
  }

  stop() {
    this.fail('was stopped');
  }
}

const PROCESSES = new Map();

// The process of helper method `key`, started on first use.
export function helperProcess(spec) {
  let p = PROCESSES.get(spec.key);
  if (!p || p.dead) {
    p = new HelperProcess(spec);
    PROCESSES.set(spec.key, p);
  }
  return p;
}

// Stops every helper process this process started.
export function stopHelpers() {
  for (const p of PROCESSES.values()) p.stop();
  PROCESSES.clear();
}

// The process ids of the helpers running now.
export const helperPids = () => [...PROCESSES.values()].filter((p) => !p.dead).map((p) => p.pid);

process.on('exit', stopHelpers);

// ---- The method.

const bigText = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
const plain = (x) => JSON.parse(JSON.stringify(x, bigText));

// The seed of a library that draws at random: two draws of the job's
// generator (opts.random), high word then low, or the battery's seed.
export function helperSeed(opts) {
  if (opts.random) {
    const w = () => BigInt(Math.floor(opts.random() * 0x100000000));
    return ((w() << 32n) | w()).toString();
  }
  if (opts.seed === undefined || opts.seed === null) throw new Error('a seed is required');
  return BigInt(opts.seed).toString();
}

// The build request of one spend (schema 1).
export function buildRequest(proc, { library, state, intent, params, opts, pool, collateral, seeded }) {
  const utxos = pool.map((u) => {
    if (proc.sent.get(u.ref) === u.cbor) return { ref: u.ref };
    proc.sent.set(u.ref, u.cbor);
    return { ref: u.ref, cbor: u.cbor };
  });
  const f = intent.fixed;
  return {
    op: 'build',
    library,
    network: state.network,
    networkId: addressBytes(state.changeAddress)[0] & 0x0f,
    at: { slot: state.at && state.at.slot !== undefined ? state.at.slot : null, time: state.at && state.at.time !== undefined ? state.at.time : null },
    stakeCred: state.stakeCred,
    changeAddress: state.changeAddress,
    utxos,
    outputs: intent.requested.map((o) => o.cbor),
    params: paramsJson(params),
    seed: seeded ? helperSeed(opts) : null,
    intent: {
      id: intent.id === undefined ? null : intent.id,
      source: intent.source === undefined ? null : intent.source,
      collateralRequired: !!(intent.collateral && intent.collateral.required),
      implicit: plain(intent.implicit || null),
      fixed: f ? plain({ inputs: f.inputs, referenceInputs: f.referenceInputs, body: f.body, witnesses: f.witnesses, redeemers: f.redeemers, auxiliaryData: f.auxiliaryData, scriptFee: f.scriptFee, fixedBytes: f.fixedBytes, refScriptBytes: f.refScriptBytes }) : null
    },
    collateral: collateral ? { ref: collateral.ref, cbor: collateral.cbor } : null
  };
}

// A helper method, with the treatment T (the layout change and the synthetic
// witnesses are built from it).
//   name, version, deterministic, seeded   the contract's
//   library     the library the helper runs, as the request names it
//   coverage    the replay parts the method covers (library.mjs REPLAY_PARTS)
//   classify    (error text) => a failure class, for an error the helper
//               leaves unclassified
//   process     { key, command, args, env }: how to start the helper
//   refused     the text of the refusal of a change policy other than
//               'default' and 'layout'
export function helperMethod(T, { name, version, deterministic, seeded, library, coverage, classify, process: spec, refused }) {
  return {
    name,
    version,
    deterministic,
    seeded,
    async build(state, intent, params, opts) {
      refuseUncovered(name, coverage, intent);
      const layout = opts.changePolicy === 'layout';
      if (opts.changePolicy !== 'default' && !layout) return { ok: false, class: CLASSES.other, detail: refused };
      const replay = intent.source === 'replay';
      if (replay) {
        const kit = replayRefusal(intent);
        if (kit) return { ok: false, class: NOT_REPLAYABLE, detail: kit };
      }
      const f = replay ? intent.fixed : null;
      const collateral = opts.collateral || null;
      if (intent.collateral && intent.collateral.required && !collateral) throw new Error(`${name}: a script spend needs the collateral the engine sets aside`);
      const fixedRefs = new Set(f ? f.inputs.map((x) => x.ref) : []);
      const pool = inputOrder(state).filter((u) => !fixedRefs.has(u.ref));
      const proc = helperProcess(spec);
      const r = await proc.request(buildRequest(proc, { library, state, intent, params, opts, pool, collateral, seeded: seeded && !deterministic }));
      const layoutOn = (walletRefs) => {
        const c = buildWithChange(T, { state, params, inputs: recordsOf(state, walletRefs), intent, policy: 'layout', collateral });
        if (!c.ok) return { ok: false, class: c.class, detail: `layout change on the library's inputs: ${c.detail}` };
        return { ok: true, kind: 'single', txs: [txRecord(c.bytes, walletRefs, c.fee, c.size, c.k)] };
      };
      if (!r.ok && layout && Array.isArray(r.inputs)) return layoutOn(r.inputs);
      if (!r.ok) {
        const text = typeof r.error === 'string' ? r.error : String(r.error);
        const detail = r.stage ? `${r.stage}: ${text}` : text;
        if (r.notReplayable) return { ok: false, class: NOT_REPLAYABLE, detail: `${r.notReplayable}: ${text}` };
        if (r.class !== undefined && r.class !== null) {
          if (!RESULT_CLASSES.has(r.class)) throw proc.error(`answered with an unknown failure class ${r.class}`);
          return { ok: false, class: r.class, detail };
        }
        return { ok: false, class: classify(text), detail };
      }
      if (typeof r.tx !== 'string' || !/^[0-9a-f]+$/.test(r.tx)) throw proc.error('answered a build without transaction bytes');
      const built = inspectTx(r.tx);
      const refs = built.inputs.map((i) => i.ref);
      for (const x of fixedRefs) if (!refs.includes(x)) return { ok: false, class: CLASSES.other, detail: `the library left out the fixed input ${x}` };
      const walletRefs = refs.filter((x) => !fixedRefs.has(x));
      if (layout) return layoutOn(walletRefs);
      const inputs = recordsOf(state, walletRefs);
      // The vkey witnesses: the wallet's keys, synthetic, then the intent's
      // other vkey witnesses as observed, written by the helper.
      const keys = replayWitnessKeys(f, { inputs, collateral: collateral ? [collateral] : [] });
      const others = f && f.witnesses[0] !== undefined ? listItems(f.witnesses[0]) : [];
      const vkeys = [...syntheticVkeys(T, keys.size), ...others].map((b) => Buffer.from(b).toString('hex'));
      const w = await proc.request({ op: 'witness', vkeys, observed: others.length });
      if (!w.ok || typeof w.tx !== 'string' || !/^[0-9a-f]+$/.test(w.tx)) throw proc.error(`did not write the witnesses: ${w.ok ? 'no transaction bytes' : w.error}`);
      const tx = inspectTx(w.tx);
      const unpriced = [...(Array.isArray(r.unpriced) ? r.unpriced : []), ...(Array.isArray(w.unpriced) ? w.unpriced : [])];
      return {
        ok: true,
        kind: 'single',
        txs: [txRecord(w.tx, walletRefs, tx.fee, tx.size, keys.size)],
        library: { fee: tx.fee, finalMinFee: minFee(params, tx.size, f ? f.scriptFee : 0n), unpriced }
      };
    }
  };
}

