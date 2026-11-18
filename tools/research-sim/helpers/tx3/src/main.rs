// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Tx3 helper of the simulator's bridge (src/methods/helper.mjs, schema 1):
// it reads one request per line on stdin and writes one response per line on
// stdout, and exits at the end of its input.
//
// Tx3 has no payment call: a caller sends a TRP server a Tx3 program and its
// arguments, and the server resolves it with tx3-resolver (Dolos v1.6.3 does
// it in crates/trp/src/methods.rs:22-53). This helper is that server for one
// spend: it writes the spend's program as Tx3 source (`program`), compiles it
// with tx3-lang 0.25.0 (Workspace parse, analyze, lower), and resolves it with
// tx3_resolver::resolve_tx (tx3-resolver 0.25.0, job.rs:239-259) against an
// in-memory UTxO store (`Store`) and tx3-cardano 0.25.0's compiler, configured
// as Dolos configures them (crates/trp/src/compiler.rs:30-83, crates/core/src/
// config.rs:838-855): the run's fee coefficients and coins per UTxO byte, no
// extra-fee setting (so tx3-cardano's default of 200,000 lovelace, lib.rs:39,
// ops.rs:5-9), and 10 optimize rounds.
//
// The program, the many-input form the study runs, for a spend paying the requested
// outputs R from the wallet W:
//
//   party Wallet; party Payee0; ...
//   tx spend(<data arguments>) {
//       input fixed0 { ref: 0x<txid>#<index>, redeemer: r0, }   the fixed inputs
//       collateral { ref: 0x<txid>#<index>, }           the UTxO set aside
//       reference ref0 { ref: 0x<txid>#<index>, }        the reference inputs
//       input* source {
//           from: Wallet,
//           min_amount: fees + min_utxo(change) + (Ada(n) + AnyAsset(p, a, q)...),
//       }
//       output { to: Payee0, amount: Ada(c) + AnyAsset(...), datum: d0, }
//       cardano::publish { to: Payee1, amount: ..., version: v, script: 0x.., }
//       output change {
//           to: Wallet,
//           amount: source + (<fixed inputs, withdrawals, mint>) - (<requested,
//                   donation, burn>) - fees,
//       }
//       mint { amount: AnyAsset(...), redeemer: r1, }  burn { ... }
//       cardano::native_witness { script: 0x.., }
//       cardano::plutus_witness { version: v, script: 0x.., }
//       cardano::withdrawal { from: 0x<reward account>, amount: N, redeemer: r2, }
//       cardano::vote_delegation_certificate { drep: 0x.., stake: 0x.., }
//       cardano::treasury_donation { coin: N, }
//       signers { 0x<key hash>, }
//       validity { since_slot: N, until_slot: M, }
//       metadata { <label>: m0, }
//   }
//
// The target holds the fee, the payment, the change minimum and any requested
// tokens: n and q are, asset by asset, what the requested outputs, the
// donation and the burn take beyond what the fixed inputs, the withdrawals and
// the mint bring, and nothing where those bring more, so the wallet always
// pays the fee and the change minimum. The constant parts of the target and
// of the change are each written in parentheses, and the fixed inputs' value
// enters the change as the constant it is rather than as a sum of the inputs'
// names (`grouped`): tx3-tir 0.19.0 takes 2^n steps to reduce a chain of n
// operations over a value not yet known, and a spend with 29 fixed inputs, or a
// payment of 40 tokens, written as one chain did not resolve in a minute. The
// change is the program's, not Tx3's:
// everything left goes back to the wallet's address as one output. Tx3 writes
// what the program says; it has no change strategy of its own.
//
// The store holds the request's UTxOs. It answers an address with the
// spendable UTxOs of the request (the state's pool) at that address, asset
// queries from every UTxO the request holds, and every reference, as Dolos's
// store answers from its indexes (crates/trp/src/utxos.rs:13-34). The program's
// wallet party is the change address, so Tx3 selects only from the wallet's
// UTxOs at that address: a query has one address, and the resolver keeps only
// the candidates at it (inputs/approximate/filter.rs:15-20); a wallet's UTxOs
// at its other addresses are never selected. Outputs are mapped
// to Tx3's UTxOs as Dolos maps them (crates/trp/src/mapping.rs:110-151).
//
// A script spend is written as Tx3 writes one: each redeemer's data on the
// input, mint, burn or withdrawal it redeems, the scripts of the witness set
// as plutus_witness blocks, and the collateral the engine set aside as the
// program's collateral block. tx3-cardano writes every redeemer with fixed
// execution units, 2,000,000 memory and 2,000,000,000 steps (lib.rs:34-37),
// and its fee prices none of them (lib.rs:91-98, "TODO: add redeemer fees"):
// the build response names the execution units as unpriced, and the kit
// judges the transaction. A collateral query takes an ADA-only UTxO only
// (inputs/approximate/filter.rs:11-13), so a set-aside UTxO holding a token
// fails the query, class collateral.
//
// A part the language or tx3-cardano cannot hold is not replayable: a datum,
// bootstrap witness or other entry of the witness set the compiler does not
// write (compile/mod.rs compile_witness_set, plutus_data and
// bootstrap_witness None), a certificate other than a vote delegation to a
// key DRep (compile_certs), a certificate's, a vote's or a proposal's
// redeemer (compile_redeemers chains spend, mint, burn and withdrawal
// redeemers only), votes, proposals and the current treasury value
// (compile_tx_body writes them None), auxiliary scripts and metadata other
// than integers, text and bytes (compile_auxiliary_data, coercion.rs
// expr_into_metadatum), and a requested output with a datum hash (outputs
// carry inline datums only, compile_output_block).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufRead, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};

use pallas::codec::minicbor;
use pallas::codec::utils::{KeepRaw, NonEmptySet};
use pallas::ledger::addresses::Address;
use pallas::ledger::primitives::{alonzo, conway, BigInt, Metadatum, PlutusData, StakeCredential};
use pallas::ledger::traverse::{Era, MultiEraOutput};
use serde::Deserialize;
use serde_json::{json, Value};
use tx3_resolver::{CanonicalAssets, Utxo, UtxoPattern, UtxoRef, UtxoSet, UtxoStore};
use tx3_tir::encoding::AnyTir;
use tx3_tir::model::v1beta0 as tir;
use tx3_tir::reduce::{ArgMap, ArgValue};

const SCHEMA: i64 = 1;
const OPTIMIZE_ROUNDS: usize = 10;

#[derive(Deserialize)]
struct RefBytes {
    #[serde(rename = "ref")]
    r: String,
    cbor: Option<String>,
}

#[derive(Deserialize)]
struct FixedInput {
    #[serde(rename = "ref")]
    r: String,
    cbor: String,
}

#[derive(Deserialize, Default)]
struct Fixed {
    #[serde(default)]
    inputs: Vec<FixedInput>,
    #[serde(default, rename = "referenceInputs")]
    reference_inputs: Vec<FixedInput>,
    #[serde(default)]
    body: BTreeMap<String, String>,
    #[serde(default)]
    witnesses: BTreeMap<String, String>,
    #[serde(default)]
    redeemers: Vec<Value>,
    #[serde(default, rename = "auxiliaryData")]
    auxiliary_data: Option<String>,
}

#[derive(Deserialize)]
struct AssetQty {
    policy: String,
    name: String,
    qty: Value,
}

#[derive(Deserialize, Default)]
struct Implicit {
    #[serde(default)]
    withdrawals: Value,
    #[serde(default)]
    refunds: Value,
    #[serde(default)]
    deposits: Value,
    #[serde(default)]
    donation: Value,
    #[serde(default)]
    mint: Vec<AssetQty>,
    #[serde(default)]
    burn: Vec<AssetQty>,
}

#[derive(Deserialize, Default)]
struct Intent {
    implicit: Option<Implicit>,
    fixed: Option<Fixed>,
}

#[derive(Deserialize, Default)]
struct At {
    slot: Option<Value>,
    time: Option<Value>,
}

#[derive(Deserialize)]
struct Request {
    op: String,
    schema: i64,
    id: Value,
    #[serde(default, rename = "networkId")]
    network_id: u8,
    #[serde(default)]
    at: Option<At>,
    #[serde(default, rename = "changeAddress")]
    change_address: String,
    #[serde(default)]
    utxos: Vec<RefBytes>,
    #[serde(default)]
    outputs: Vec<String>,
    #[serde(default)]
    params: BTreeMap<String, Value>,
    #[serde(default)]
    intent: Intent,
    #[serde(default)]
    collateral: Option<FixedInput>,
    #[serde(default)]
    vkeys: Vec<String>,
}

// The part a redeemer redeems, as the history reader records it.
#[derive(Deserialize)]
struct Target {
    kind: String,
    #[serde(default, rename = "ref")]
    r: Option<String>,
    #[serde(default)]
    policy: Option<String>,
    #[serde(default)]
    account: Option<String>,
}

#[derive(Deserialize)]
struct Redeemer {
    target: Option<Target>,
    data: String,
}

// A failed build: the library's error text, where it failed, and, for a part
// nothing can write, the part.
struct Failure {
    error: String,
    stage: Option<&'static str>,
    not_replayable: Option<String>,
    class: Option<&'static str>,
}

fn not_replayable(part: &str, why: impl Into<String>) -> Failure {
    Failure { error: why.into(), stage: None, not_replayable: Some(part.to_string()), class: None }
}

fn at_stage(stage: &'static str, e: impl std::fmt::Display) -> Failure {
    Failure { error: e.to_string(), stage: Some(stage), not_replayable: None, class: None }
}

// The bytes of every reference this process has been sent.
#[derive(Default)]
struct Session {
    sent: HashMap<String, Vec<u8>>,
    last: Option<Vec<u8>>,
    // The last build's fee coefficients, minFeeA and minFeeB.
    fee: (u64, u64),
}

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    let mut session = Session::default();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => return,
        };
        if line.trim().is_empty() {
            continue;
        }
        let q: Request = match serde_json::from_str(&line) {
            Ok(q) => q,
            Err(e) => {
                eprintln!("tx3 helper: a request that is not one it reads: {e}");
                std::process::exit(2);
            }
        };
        let mut r = answer(&mut session, &q);
        r["id"] = q.id.clone();
        writeln!(out, "{r}").and_then(|_| out.flush()).unwrap_or_else(|_| std::process::exit(0));
    }
}

fn answer(session: &mut Session, q: &Request) -> Value {
    if q.schema != SCHEMA {
        return json!({ "ok": false, "error": format!("schema {}, the helper's {}", q.schema, SCHEMA) });
    }
    match q.op.as_str() {
        "build" => match build(session, q) {
            Ok((tx, unpriced)) => {
                session.last = Some(tx.clone());
                if unpriced {
                    json!({ "ok": true, "tx": hex::encode(tx), "unpriced": ["execution units"] })
                } else {
                    json!({ "ok": true, "tx": hex::encode(tx) })
                }
            }
            Err(f) => {
                session.last = None;
                let mut v = json!({ "ok": false, "error": f.error });
                if let Some(s) = f.stage {
                    v["stage"] = json!(s);
                }
                if let Some(p) = f.not_replayable {
                    v["notReplayable"] = json!(p);
                }
                if let Some(c) = f.class {
                    v["class"] = json!(c);
                }
                v
            }
        },
        "witness" => match witness(session, q) {
            Ok((tx, fee)) => {
                // Tx3's fee prices no vkey witness by its size: it adds a flat
                // extra fee instead (tx3-cardano lib.rs:39, ops.rs:5-9). The
                // witnesses are named as unpriced when the transaction with
                // them is short of the size fee.
                let (a, b) = session.fee;
                if !q.vkeys.is_empty() && fee < a * tx.len() as u64 + b {
                    json!({ "ok": true, "tx": hex::encode(tx), "unpriced": ["vkey witnesses"] })
                } else {
                    json!({ "ok": true, "tx": hex::encode(tx) })
                }
            }
            Err(e) => json!({ "ok": false, "error": e }),
        },
        op => json!({ "ok": false, "error": format!("unknown op {op}") }),
    }
}

// ---- Numbers and values.

fn int_of(v: &Value) -> Result<i128, Failure> {
    match v {
        Value::Null => Ok(0),
        Value::Number(n) => n.as_i64().map(i128::from).ok_or_else(|| at_stage("request", format!("not an integer: {n}"))),
        Value::String(s) => s.parse::<i128>().map_err(|_| at_stage("request", format!("not an integer: {s}"))),
        x => Err(at_stage("request", format!("not an integer: {x}"))),
    }
}

fn param(q: &Request, k: &str) -> Result<u64, Failure> {
    let v = q.params.get(k).ok_or_else(|| at_stage("request", format!("no protocol parameter {k}")))?;
    let n = int_of(v)?;
    u64::try_from(n).map_err(|_| at_stage("request", format!("protocol parameter {k} is {n}")))
}

// A multi-asset amount: (policy hex, name hex) -> quantity; lovelace is ("", "").
type Amounts = BTreeMap<(String, String), i128>;

fn add(a: &mut Amounts, policy: &str, name: &str, q: i128) {
    *a.entry((policy.to_string(), name.to_string())).or_insert(0) += q;
}

// A Tx3 bytes literal; an empty value is the empty string, which Tx3 reads as
// empty bytes (tx3-tir reduce expect_constant_name, tx3-cardano coercion
// expr_into_bytes).
fn bytes_lit(h: &str) -> String {
    if h.is_empty() {
        "\"\"".to_string()
    } else {
        format!("0x{h}")
    }
}

// The asset terms of an amount, each with its sign: " + Ada(n) - AnyAsset(...)".
fn terms(a: &Amounts) -> String {
    let mut s = String::new();
    for ((policy, name), q) in a {
        if *q == 0 {
            continue;
        }
        let sign = if *q > 0 { '+' } else { '-' };
        let n = q.unsigned_abs();
        if policy.is_empty() {
            s.push_str(&format!(" {sign} Ada({n})"));
        } else {
            s.push_str(&format!(" {sign} AnyAsset(0x{policy}, {}, {n})", bytes_lit(name)));
        }
    }
    s
}

// An amount's asset expression, every quantity positive.
fn amount_expr(a: &Amounts) -> String {
    let t = terms(a);
    let t = t.trim_start();
    t.strip_prefix("+ ").unwrap_or(t).to_string()
}

// An amount added to an expression that is not yet constant (the inputs, the
// fee): " + (what it adds) - (what it takes)", each side a constant in
// parentheses. tx3-tir 0.19.0 reduces an operation whose operands are not yet
// constant twice (reduce/mod.rs:1247-1250), so a chain of n operations over
// such a value takes 2^n steps, while a parenthesized constant reduces once.
fn grouped(a: &Amounts) -> String {
    let pos: Amounts = a.iter().filter(|(_, q)| **q > 0).map(|(k, q)| (k.clone(), *q)).collect();
    let neg: Amounts = a.iter().filter(|(_, q)| **q < 0).map(|(k, q)| (k.clone(), -*q)).collect();
    let mut s = String::new();
    if !pos.is_empty() {
        s.push_str(&format!(" + ({})", amount_expr(&pos)));
    }
    if !neg.is_empty() {
        s.push_str(&format!(" - ({})", amount_expr(&neg)));
    }
    s
}

fn output_amounts(o: &MultiEraOutput) -> Amounts {
    let mut a = Amounts::new();
    let v = o.value();
    add(&mut a, "", "", v.coin() as i128);
    for p in v.assets() {
        for x in p.assets() {
            add(&mut a, &hex::encode(p.policy().as_slice()), &hex::encode(x.name()), x.any_coin());
        }
    }
    a
}

// ---- UTxOs, as Dolos maps them (crates/trp/src/mapping.rs).

fn split_unspent(cbor: &[u8]) -> Result<(UtxoRef, Vec<u8>), String> {
    let mut d = minicbor::Decoder::new(cbor);
    d.array().map_err(|e| e.to_string())?;
    d.array().map_err(|e| e.to_string())?;
    let txid = d.bytes().map_err(|e| e.to_string())?.to_vec();
    let index = d.u32().map_err(|e| e.to_string())?;
    let start = d.position();
    d.skip().map_err(|e| e.to_string())?;
    Ok((UtxoRef { txid, index }, cbor[start..d.position()].to_vec()))
}

fn decode_output(bytes: &[u8]) -> Result<MultiEraOutput<'_>, String> {
    MultiEraOutput::decode(Era::Conway, bytes).map_err(|e| e.to_string())
}

fn data_expr(d: &PlutusData) -> tir::Expression {
    match d {
        PlutusData::Constr(c) => tir::Expression::Struct(tir::StructExpr { constructor: constructor_of(c) as usize, fields: c.fields.iter().map(data_expr).collect() }),
        PlutusData::Map(m) => tir::Expression::Map(m.iter().map(|(k, v)| (data_expr(k), data_expr(v))).collect()),
        PlutusData::BigInt(b) => tir::Expression::Number(big_of(b).unwrap_or_default()),
        PlutusData::BoundedBytes(b) => tir::Expression::Bytes(b.to_vec()),
        PlutusData::Array(xs) => tir::Expression::List(xs.iter().map(data_expr).collect()),
    }
}

fn constructor_of<A>(c: &pallas::ledger::primitives::Constr<A>) -> u64 {
    match c.tag {
        121..=127 => c.tag - 121,
        1280..=1400 => c.tag - 1280 + 7,
        _ => c.any_constructor.unwrap_or_default(),
    }
}

fn big_of(b: &BigInt) -> Option<i128> {
    match b {
        BigInt::Int(x) => Some(i128::from(*x)),
        BigInt::BigUInt(bytes) | BigInt::BigNInt(bytes) => {
            if bytes.len() > 15 {
                return None;
            }
            let mut n = 0i128;
            for &x in bytes.iter() {
                n = (n << 8) | x as i128;
            }
            Some(if matches!(b, BigInt::BigNInt(_)) { -1 - n } else { n })
        }
    }
}

fn data_arg(d: &PlutusData) -> Result<ArgValue, String> {
    Ok(match d {
        PlutusData::Constr(c) => ArgValue::Struct { constructor: constructor_of(c) as usize, fields: c.fields.iter().map(data_arg).collect::<Result<_, _>>()? },
        PlutusData::Map(m) => ArgValue::Map(m.iter().map(|(k, v)| Ok((data_arg(k)?, data_arg(v)?))).collect::<Result<_, String>>()?),
        PlutusData::BigInt(b) => ArgValue::Int(big_of(b).ok_or("an integer wider than 120 bits")?),
        PlutusData::BoundedBytes(b) => ArgValue::Bytes(b.to_vec()),
        PlutusData::Array(xs) => ArgValue::List(xs.iter().map(data_arg).collect::<Result<_, _>>()?),
    })
}

fn tx3_utxo(r: UtxoRef, out: &[u8]) -> Result<Utxo, String> {
    let o = decode_output(out)?;
    let address = o.address().map_err(|e| e.to_string())?.to_vec();
    let mut assets = CanonicalAssets::from_naked_amount(o.value().coin() as i128);
    for p in o.value().assets() {
        for x in p.assets() {
            assets = assets + CanonicalAssets::from_defined_asset(p.policy().as_slice(), x.name(), x.any_coin());
        }
    }
    let datum = match o.datum() {
        Some(conway::DatumOption::Data(x)) => Some(data_expr(&x.0)),
        _ => None,
    };
    let script = o.script_ref().map(|s| minicbor::to_vec(&s)).transpose().map_err(|e| e.to_string())?.map(tir::Expression::Bytes);
    Ok(Utxo { r#ref: r, address, assets, datum, script })
}

// ---- The store.

struct Store {
    pool: HashSet<UtxoRef>,
    utxos: HashMap<UtxoRef, Utxo>,
}

impl Store {
    fn holding(&self, policy: &[u8], name: Option<&[u8]>) -> HashSet<UtxoRef> {
        self.utxos
            .values()
            .filter(|u| {
                u.assets.classes().iter().any(|c| c.policy() == Some(policy) && name.is_none_or(|n| c.name() == Some(n)))
            })
            .map(|u| u.r#ref.clone())
            .collect()
    }
}

impl UtxoStore for Store {
    async fn narrow_refs(&self, pattern: UtxoPattern<'_>) -> Result<HashSet<UtxoRef>, tx3_resolver::Error> {
        Ok(match pattern {
            UtxoPattern::ByAddress(a) => self.pool.iter().filter(|r| self.utxos.get(*r).is_some_and(|u| u.address == a)).cloned().collect(),
            UtxoPattern::ByAssetPolicy(p) => self.holding(p, None),
            UtxoPattern::ByAsset(p, n) => self.holding(p, Some(n)),
        })
    }

    async fn fetch_utxos(&self, refs: HashSet<UtxoRef>) -> Result<UtxoSet, tx3_resolver::Error> {
        let mut out = UtxoSet::new();
        for r in refs {
            let u = self.utxos.get(&r).ok_or_else(|| tx3_resolver::Error::StoreError(format!("no UTxO {r}")))?;
            out.insert(u.clone());
        }
        Ok(out)
    }
}

// ---- The program.

struct Program {
    head: Vec<String>,
    params: Vec<String>,
    body: Vec<String>,
    args: ArgMap,
}

impl Program {
    fn arg(&mut self, name: String, ty: &str, v: ArgValue) -> String {
        self.params.push(format!("{name}: {ty}"));
        self.args.insert(name.clone(), v);
        name
    }

    fn party(&mut self, name: &str, address: Vec<u8>) {
        self.head.push(format!("party {name};"));
        self.args.insert(name.to_lowercase(), ArgValue::Address(address));
    }

    fn source(&self) -> String {
        format!("{}\n\ntx spend({}) {{\n{}\n}}\n", self.head.join("\n"), self.params.join(", "), self.body.join("\n"))
    }
}

fn ref_lit(r: &str) -> Result<String, Failure> {
    let (txid, ix) = r.split_once('#').ok_or_else(|| at_stage("request", format!("not a reference: {r}")))?;
    Ok(format!("0x{txid}#{ix}"))
}

fn items(h: &str) -> Result<Vec<Vec<u8>>, String> {
    let b = hex::decode(h).map_err(|e| e.to_string())?;
    let mut d = minicbor::Decoder::new(&b);
    if d.datatype().map_err(|e| e.to_string())? == minicbor::data::Type::Tag {
        d.tag().map_err(|e| e.to_string())?;
    }
    let n = d.array().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut i = 0u64;
    loop {
        if let Some(n) = n {
            if i == n {
                break;
            }
        } else if d.datatype().map_err(|e| e.to_string())? == minicbor::data::Type::Break {
            break;
        }
        let start = d.position();
        d.skip().map_err(|e| e.to_string())?;
        out.push(b[start..d.position()].to_vec());
        i += 1;
    }
    Ok(out)
}

fn uint_field(h: &str) -> Result<u64, Failure> {
    let b = hex::decode(h).map_err(|e| at_stage("replay parts", e))?;
    minicbor::Decoder::new(&b).u64().map_err(|e| at_stage("replay parts", e))
}

// The spend's program and its arguments, or the first part nothing can write.
fn program(q: &Request, wallet: &[u8], fixed_values: &[Amounts]) -> Result<Program, Failure> {
    let mut p = Program { head: Vec::new(), params: Vec::new(), body: Vec::new(), args: ArgMap::new() };
    p.party("Wallet", wallet.to_vec());
    let empty = Fixed::default();
    let f = q.intent.fixed.as_ref().unwrap_or(&empty);
    let imp = q.intent.implicit.as_ref();

    // Redeemers, by the part each redeems, each as a data argument. Tx3
    // attaches a redeemer to a spent input, a mint or burn, or a withdrawal
    // only (compile/mod.rs compile_redeemers, "TODO: chain other
    // redeemers"), and writes each with its fixed execution units.
    let mut spend_r: HashMap<String, String> = HashMap::new();
    let mut mint_r: HashMap<String, String> = HashMap::new();
    let mut reward_r: HashMap<String, String> = HashMap::new();
    for (i, v) in f.redeemers.iter().enumerate() {
        let r: Redeemer = serde_json::from_value(v.clone()).map_err(|e| at_stage("replay parts", e))?;
        let t = r.target.ok_or_else(|| at_stage("replay parts", "a redeemer with no target"))?;
        let slot = match t.kind.as_str() {
            "input" => (&mut spend_r, t.r),
            "policy" => (&mut mint_r, t.policy),
            "withdrawal" => (&mut reward_r, t.account),
            k @ ("certificate" | "voter" | "proposal") => {
                let part = match k {
                    "certificate" => "certificate redeemer",
                    "voter" => "vote redeemer",
                    _ => "proposal redeemer",
                };
                return Err(not_replayable(part, "Tx3 attaches redeemers to spent inputs, mints and burns, and withdrawals only"));
            }
            k => return Err(at_stage("replay parts", format!("a redeemer of an unknown target {k}"))),
        };
        let b = hex::decode(&r.data).map_err(|e| at_stage("replay parts", e))?;
        let d: PlutusData = minicbor::decode(&b).map_err(|e| at_stage("replay parts", e))?;
        let arg = data_arg(&d).map_err(|e| not_replayable("redeemer data", format!("Tx3 holds a redeemer's integers in 128 bits: {e}")))?;
        let name = p.arg(format!("r{i}"), "Bytes", arg);
        slot.0.insert(slot.1.unwrap_or_default(), name);
    }
    for (k, why) in [("2", "bootstrap witnesses"), ("4", "witness datums")] {
        if f.witnesses.contains_key(k) {
            return Err(not_replayable(why, format!("Tx3 writes no {why} into the witness set")));
        }
    }
    for k in f.witnesses.keys() {
        if !["0", "1", "3", "5", "6", "7"].contains(&k.as_str()) {
            return Err(not_replayable(&format!("witness set entry {k}"), format!("Tx3 writes no witness set entry {k}")));
        }
    }
    for (k, why) in [("19", "votes"), ("20", "proposals"), ("21", "current treasury value")] {
        if f.body.contains_key(k) {
            return Err(not_replayable(why, format!("Tx3 writes no {why}")));
        }
    }
    for k in f.body.keys() {
        if !["3", "4", "5", "8", "9", "14", "22"].contains(&k.as_str()) {
            return Err(not_replayable(&format!("body field {k}"), format!("Tx3 writes no body field {k}")));
        }
    }
    if let Some(imp) = imp {
        if int_of(&imp.deposits)? != 0 || int_of(&imp.refunds)? != 0 {
            return Err(not_replayable("certificates", "Tx3 writes no certificate that takes a deposit or returns one"));
        }
    }
    let mut certs = Vec::new();
    if let Some(h) = f.body.get("4") {
        for b in items(h).map_err(|e| at_stage("replay parts", e))? {
            match minicbor::decode::<conway::Certificate>(&b) {
                Ok(conway::Certificate::VoteDeleg(cred, conway::DRep::Key(drep))) => certs.push((cred, drep)),
                _ => return Err(not_replayable("certificates", "Tx3 writes vote delegations to a key DRep only")),
            }
        }
    }
    let mut metadata = Vec::new();
    if let Some(h) = &f.auxiliary_data {
        let b = hex::decode(h).map_err(|e| at_stage("replay parts", e))?;
        let aux: alonzo::AuxiliaryData = minicbor::decode(&b).map_err(|e| at_stage("replay parts", e))?;
        let md = match aux {
            alonzo::AuxiliaryData::Shelley(m) => Some(m),
            alonzo::AuxiliaryData::ShelleyMa(x) => {
                if x.auxiliary_scripts.as_ref().is_some_and(|s| !s.is_empty()) {
                    return Err(not_replayable("auxiliary scripts", "Tx3 writes metadata only"));
                }
                Some(x.transaction_metadata)
            }
            alonzo::AuxiliaryData::PostAlonzo(x) => {
                if x.native_scripts.as_ref().is_some_and(|s| !s.is_empty()) || x.plutus_scripts.as_ref().is_some_and(|s| !s.is_empty()) {
                    return Err(not_replayable("auxiliary scripts", "Tx3 writes metadata only"));
                }
                x.metadata
            }
        };
        for (label, v) in md.unwrap_or_default() {
            let arg = match v {
                Metadatum::Int(i) => {
                    let n = i128::from(i);
                    if i64::try_from(n).is_err() {
                        return Err(not_replayable("metadata", "Tx3 writes a metadata integer as 64 bits"));
                    }
                    ("Int", ArgValue::Int(n))
                }
                Metadatum::Text(s) => ("Bytes", ArgValue::String(s)),
                Metadatum::Bytes(b) => ("Bytes", ArgValue::Bytes(b.to_vec())),
                _ => return Err(not_replayable("metadata", "Tx3 writes metadata values that are integers, text or bytes only")),
            };
            metadata.push((label, arg));
        }
    }

    // The amounts the program moves.
    let mut brought = Amounts::new();
    for v in fixed_values {
        for (k, q) in v {
            add(&mut brought, &k.0, &k.1, *q);
        }
    }
    let mut taken = Amounts::new();
    let (mut withdrawn, mut donation) = (0i128, 0i128);
    let mut mints: BTreeMap<String, Amounts> = BTreeMap::new();
    let mut burns: BTreeMap<String, Amounts> = BTreeMap::new();
    if let Some(imp) = imp {
        withdrawn = int_of(&imp.withdrawals)?;
        donation = int_of(&imp.donation)?;
        for a in &imp.mint {
            let n = int_of(&a.qty)?;
            add(&mut brought, &a.policy, &a.name, n);
            add(mints.entry(a.policy.clone()).or_default(), &a.policy, &a.name, n);
        }
        for a in &imp.burn {
            let n = int_of(&a.qty)?;
            add(&mut taken, &a.policy, &a.name, n);
            add(burns.entry(a.policy.clone()).or_default(), &a.policy, &a.name, n);
        }
    }
    add(&mut brought, "", "", withdrawn);
    add(&mut taken, "", "", donation);

    // Fixed and reference inputs.
    for (i, x) in f.inputs.iter().enumerate() {
        let redeemer = spend_r.remove(&x.r).map(|r| format!(" redeemer: {r},")).unwrap_or_default();
        p.body.push(format!("    input fixed{i} {{ ref: {},{redeemer} }}", ref_lit(&x.r)?));
    }
    // The collateral the engine set aside for a script spend.
    if let Some(c) = &q.collateral {
        p.body.push(format!("    collateral {{ ref: {}, }}", ref_lit(&c.r)?));
    }
    for (i, x) in f.reference_inputs.iter().enumerate() {
        p.body.push(format!("    reference ref{i} {{ ref: {}, }}", ref_lit(&x.r)?));
    }

    // The requested outputs.
    let mut outputs = Vec::new();
    for (i, h) in q.outputs.iter().enumerate() {
        let b = hex::decode(h).map_err(|e| at_stage("requested output", e))?;
        let o = decode_output(&b).map_err(|e| at_stage("requested output", e))?;
        let address = o.address().map_err(|e| at_stage("requested output", e))?.to_vec();
        let a = output_amounts(&o);
        for (k, n) in &a {
            add(&mut taken, &k.0, &k.1, *n);
        }
        let payee = format!("Payee{i}");
        p.party(&payee, address);
        let datum = match o.datum() {
            None => None,
            Some(conway::DatumOption::Hash(_)) => return Err(not_replayable("output datum hash", "Tx3 writes inline datums only")),
            Some(conway::DatumOption::Data(d)) => {
                let v = data_arg(&d.0).map_err(|e| not_replayable("output datum", format!("Tx3 holds a datum's integers in 128 bits: {e}")))?;
                Some(p.arg(format!("d{i}"), "Bytes", v))
            }
        };
        let datum = datum.map(|d| format!(" datum: {d},")).unwrap_or_default();
        match o.script_ref() {
            None => outputs.push(format!("    output {{ to: {payee}, amount: {},{datum} }}", amount_expr(&a))),
            Some(s) => {
                let (version, script) = match &s {
                    conway::ScriptRef::NativeScript(n) => (0, n.raw_cbor().to_vec()),
                    conway::ScriptRef::PlutusV1Script(x) => (1, x.0.to_vec()),
                    conway::ScriptRef::PlutusV2Script(x) => (2, x.0.to_vec()),
                    conway::ScriptRef::PlutusV3Script(x) => (3, x.0.to_vec()),
                };
                outputs.push(format!("    cardano::publish {{ to: {payee}, amount: {},{datum} version: {version}, script: 0x{}, }}", amount_expr(&a), hex::encode(script)));
            }
        }
    }

    // The target: what the wallet must bring, at least nothing per asset.
    let mut need = Amounts::new();
    for (k, n) in &taken {
        let net = n - brought.get(k).copied().unwrap_or(0);
        if net > 0 {
            need.insert(k.clone(), net);
        }
    }
    p.body.push(format!("    input* source {{\n        from: Wallet,\n        min_amount: fees + min_utxo(change){},\n    }}", grouped(&need)));
    p.body.extend(outputs);
    let mut rest = brought.clone();
    for (k, n) in &taken {
        add(&mut rest, &k.0, &k.1, -n);
    }
    p.body.push(format!("    output change {{\n        to: Wallet,\n        amount: source{} - fees,\n    }}", grouped(&rest)));

    // Mint and burn, one block per policy.
    for (policy, a) in mints {
        let redeemer = mint_r.remove(&policy).map(|r| format!(" redeemer: {r},")).unwrap_or_default();
        p.body.push(format!("    mint {{ amount: {},{redeemer} }}", amount_expr(&a)));
    }
    for (policy, a) in burns {
        let redeemer = mint_r.remove(&policy).map(|r| format!(" redeemer: {r},")).unwrap_or_default();
        p.body.push(format!("    burn {{ amount: {},{redeemer} }}", amount_expr(&a)));
    }

    // Scripts of the witness set.
    if let Some(h) = f.witnesses.get("1") {
        for s in items(h).map_err(|e| at_stage("replay parts", e))? {
            p.body.push(format!("    cardano::native_witness {{ script: 0x{}, }}", hex::encode(s)));
        }
    }
    for (k, v) in [("3", 1), ("6", 2), ("7", 3)] {
        if let Some(h) = f.witnesses.get(k) {
            for s in items(h).map_err(|e| at_stage("replay parts", e))? {
                let inner = minicbor::Decoder::new(&s).bytes().map_err(|e| at_stage("replay parts", e))?.to_vec();
                p.body.push(format!("    cardano::plutus_witness {{ version: {v}, script: 0x{}, }}", hex::encode(inner)));
            }
        }
    }

    // Withdrawals.
    if let Some(h) = f.body.get("5") {
        let b = hex::decode(h).map_err(|e| at_stage("replay parts", e))?;
        let mut d = minicbor::Decoder::new(&b);
        let n = d.map().map_err(|e| at_stage("replay parts", e))?.unwrap_or(0);
        for _ in 0..n {
            let acct = d.bytes().map_err(|e| at_stage("replay parts", e))?.to_vec();
            let amount = d.u64().map_err(|e| at_stage("replay parts", e))?;
            let redeemer = reward_r.remove(&hex::encode(&acct)).map(|r| format!(" redeemer: {r},")).unwrap_or_default();
            p.body.push(format!("    cardano::withdrawal {{ from: 0x{}, amount: {amount},{redeemer} }}", hex::encode(&acct)));
        }
    }

    // Vote delegations.
    for (cred, drep) in certs {
        let header = q.network_id & 0x0f;
        let (kind, hash) = match cred {
            StakeCredential::AddrKeyhash(h) => (0xe0u8, h),
            StakeCredential::ScriptHash(h) => (0xf0u8, h),
        };
        let mut stake = vec![kind | header];
        stake.extend_from_slice(hash.as_slice());
        p.body.push(format!("    cardano::vote_delegation_certificate {{ drep: 0x{}, stake: 0x{}, }}", hex::encode(drep.as_slice()), hex::encode(stake)));
    }

    if donation != 0 {
        p.body.push(format!("    cardano::treasury_donation {{ coin: {donation}, }}"));
    }

    if let Some(h) = f.body.get("14") {
        let signers: Vec<String> = items(h).map_err(|e| at_stage("replay parts", e))?.iter().map(|b| minicbor::Decoder::new(b).bytes().map(|x| format!("0x{}, ", hex::encode(x)))).collect::<Result<_, _>>().map_err(|e| at_stage("replay parts", e))?;
        p.body.push(format!("    signers {{ {}}}", signers.concat()));
    }

    let since = f.body.get("8").map(|h| uint_field(h)).transpose()?;
    let until = f.body.get("3").map(|h| uint_field(h)).transpose()?;
    if since.is_some() || until.is_some() {
        let mut v = String::new();
        if let Some(s) = since {
            v.push_str(&format!(" since_slot: {s},"));
        }
        if let Some(u) = until {
            v.push_str(&format!(" until_slot: {u},"));
        }
        p.body.push(format!("    validity {{{v} }}"));
    }

    if !metadata.is_empty() {
        let mut fields = Vec::new();
        for (i, (label, (ty, v))) in metadata.into_iter().enumerate() {
            let name = p.arg(format!("m{i}"), ty, v);
            fields.push(format!(" {label}: {name},"));
        }
        p.body.push(format!("    metadata {{{} }}", fields.concat()));
    }
    if let Some(k) = spend_r.keys().chain(mint_r.keys()).chain(reward_r.keys()).next() {
        return Err(at_stage("replay parts", format!("a redeemer for {k}, which no block of the program writes")));
    }
    Ok(p)
}

// ---- The build.

fn build(session: &mut Session, q: &Request) -> Result<(Vec<u8>, bool), Failure> {
    let wallet = Address::from_bech32(&q.change_address).map_err(|e| at_stage("request", e))?.to_vec();
    let mut store = Store { pool: HashSet::new(), utxos: HashMap::new() };
    for u in &q.utxos {
        let cbor = match &u.cbor {
            Some(h) => {
                let b = hex::decode(h).map_err(|e| at_stage("request", e))?;
                session.sent.insert(u.r.clone(), b.clone());
                b
            }
            None => session.sent.get(&u.r).cloned().ok_or_else(|| at_stage("request", format!("{} was never sent", u.r)))?,
        };
        let (r, out) = split_unspent(&cbor).map_err(|e| at_stage("request", e))?;
        let utxo = tx3_utxo(r.clone(), &out).map_err(|e| at_stage("request", e))?;
        store.pool.insert(r.clone());
        store.utxos.insert(r, utxo);
    }
    let mut fixed_values = Vec::new();
    if let Some(f) = &q.intent.fixed {
        for (i, x) in f.inputs.iter().chain(f.reference_inputs.iter()).enumerate() {
            let b = hex::decode(&x.cbor).map_err(|e| at_stage("replay parts", e))?;
            let (r, out) = split_unspent(&b).map_err(|e| at_stage("replay parts", e))?;
            if i < f.inputs.len() {
                fixed_values.push(output_amounts(&decode_output(&out).map_err(|e| at_stage("replay parts", e))?));
            }
            let utxo = tx3_utxo(r.clone(), &out).map_err(|e| at_stage("replay parts", e))?;
            store.utxos.entry(r).or_insert(utxo);
        }
    }
    // The collateral set aside resolves by reference and is never in the pool.
    if let Some(c) = &q.collateral {
        let b = hex::decode(&c.cbor).map_err(|e| at_stage("request", e))?;
        let (r, out) = split_unspent(&b).map_err(|e| at_stage("request", e))?;
        store.utxos.insert(r.clone(), tx3_utxo(r, &out).map_err(|e| at_stage("request", e))?);
    }
    session.fee = (param(q, "minFeeA")?, param(q, "minFeeB")?);
    let prog = program(q, &wallet, &fixed_values)?;
    let src = prog.source();
    if std::env::var_os("TX3_HELPER_PROGRAMS").is_some() {
        eprintln!("tx3 helper: program\n{src}");
    }

    let lowered = catch_unwind(AssertUnwindSafe(|| -> Result<tir::Tx, String> {
        let mut ws = tx3_lang::Workspace::from_string(src.clone());
        ws.parse().map_err(|e| e.to_string())?;
        ws.analyze().map_err(|e| e.to_string())?;
        if let Some(a) = ws.analisis() {
            if !a.errors.is_empty() {
                return Err(format!("{:?}", a.errors));
            }
        }
        ws.lower().map_err(|e| e.to_string())?;
        ws.tir("spend").cloned().ok_or_else(|| "the program has no transaction spend".to_string())
    }));
    let tx = match lowered {
        Ok(Ok(tx)) => tx,
        Ok(Err(e)) => return Err(at_stage("program", e)),
        Err(p) => return Err(at_stage("program", panic_text(p))),
    };

    // The run holds no cost models. The compiler needs one for each Plutus
    // language a transaction uses to write the script data hash
    // (compile/script_data.rs:77-121); an empty one stands in, so the hash
    // keeps its 32 bytes and only its value differs, which no check reads
    // (the kit's own replay assembly hashes no cost models either).
    let network = if q.network_id == 1 { pallas::ledger::primitives::NetworkId::Mainnet } else { pallas::ledger::primitives::NetworkId::Testnet };
    let pparams = tx3_cardano::PParams { network, min_fee_coefficient: param(q, "minFeeA")?, min_fee_constant: param(q, "minFeeB")?, coins_per_utxo_byte: param(q, "coinsPerUtxoByte")?, cost_models: HashMap::from([(0, Vec::new()), (1, Vec::new()), (2, Vec::new())]) };
    let at = q.at.as_ref();
    let slot = at.and_then(|a| a.slot.as_ref()).map(int_of).transpose()?.unwrap_or(0);
    let time = at.and_then(|a| a.time.as_ref()).map(int_of).transpose()?.unwrap_or(0);
    let mut compiler = tx3_cardano::Compiler::new(pparams, tx3_cardano::Config { extra_fees: None }, tx3_cardano::ChainPoint { slot: slot.max(0) as u64, hash: Vec::new(), timestamp: time.max(0) as u128 });
    let resolved = catch_unwind(AssertUnwindSafe(|| pollster::block_on(tx3_resolver::resolve_tx(AnyTir::V1Beta0(tx), &prog.args, &mut compiler, &store, OPTIMIZE_ROUNDS))));
    match resolved {
        // Tx3's fee prices no execution units (lib.rs:91-98).
        Ok(Ok(c)) => Ok((c.payload, q.intent.fixed.as_ref().is_some_and(|f| !f.redeemers.is_empty()))),
        Ok(Err(e)) => {
            let class = match &e {
                tx3_resolver::Error::InputNotResolved(x) if x.name == "source" => Some("balance"),
                // The set-aside UTxO is not one a collateral query takes (it
                // holds a token; inputs/approximate/filter.rs:11-13).
                tx3_resolver::Error::InputNotResolved(x) if x.name == "collateral" => Some("collateral"),
                _ => None,
            };
            Err(Failure { error: e.to_string(), stage: Some("resolve"), not_replayable: None, class })
        }
        Err(p) => Err(at_stage("resolve", format!("Tx3 panicked: {}", panic_text(p)))),
    }
}

fn panic_text(p: Box<dyn std::any::Any + Send>) -> String {
    p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_else(|| "a panic".to_string())
}

// The vkey witnesses written into the last built transaction with pallas, as
// Dolos's trp.submit writes a signer's witnesses (crates/trp/src/methods.rs
// apply_witnesses), in place of any it holds.
fn witness(session: &mut Session, q: &Request) -> Result<(Vec<u8>, u64), String> {
    let last = session.last.as_ref().ok_or("no transaction was built")?;
    let mut tx: conway::Tx = minicbor::decode(last).map_err(|e| e.to_string())?;
    let mut vkeys = Vec::new();
    for h in &q.vkeys {
        let b = hex::decode(h).map_err(|e| e.to_string())?;
        let w: conway::VKeyWitness = minicbor::decode(&b).map_err(|e| e.to_string())?;
        vkeys.push(w);
    }
    let mut ws = tx.transaction_witness_set.unwrap();
    ws.vkeywitness = NonEmptySet::from_vec(vkeys);
    tx.transaction_witness_set = KeepRaw::from(ws);
    let fee = tx.transaction_body.fee;
    Ok((minicbor::to_vec(&tx).map_err(|e| e.to_string())?, fee))
}
