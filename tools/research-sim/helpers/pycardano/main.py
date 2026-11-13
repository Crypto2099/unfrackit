# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam K. Dean

# The PyCardano helper of the simulator's bridge (src/methods/helper.mjs,
# schema 1): it reads one request per line on stdin and writes one response
# per line on stdout, and exits at the end of its input. It runs in the
# virtual environment scripts/build-helpers.mjs pycardano builds, started by
# the launcher written beside it.
#
# A build is PyCardano's transaction builder at its defaults, called as a dapp
# calls it for a payment (pycardano 0.19.2, Python-Cardano/pycardano at
# 0445f30; pycardano/txbuilder.py):
#
#     builder = TransactionBuilder(context)
#     builder.add_input_address(address)   for each of the wallet's addresses
#     builder.add_output(output)           for each requested output
#     ...the replay's fixed parts through the builder's operations...
#     builder.build(change_address=address)
#
# with the builder's default utxo_selectors, [LargestFirstSelector(),
# RandomImproveMultiAsset()] (txbuilder.py:107-109): largest first by
# lovelace, and the random-improve selector only when the first raises
# (txbuilder.py:1417-1463). The random-improve selector draws from the module
# random (coinselection.py:166), which is seeded from the request's seed
# before each build. The transaction is the body build() returns with the
# witness set build_and_sign writes (build_witness_set(True),
# txbuilder.py:1724), the vkey witnesses left to the witness request.
#
# The chain context is the request's: the run's protocol parameters, the
# network, the spend's slot, and the wallet's UTxOs, which utxos(address)
# returns by address in the request's order. The input addresses are the
# addresses of the wallet's UTxOs in the order each first appears.

import dataclasses
import json
import logging
import random
import sys
import typing
from fractions import Fraction

from pycardano import (
    Address,
    AuxiliaryData,
    ExecutionUnits,
    MultiAsset,
    NativeScript,
    Network,
    PlutusV1Script,
    PlutusV2Script,
    PlutusV3Script,
    Redeemer,
    Transaction,
    TransactionBody,
    TransactionBuilder,
    TransactionOutput,
    UTxO,
    VerificationKeyWitness,
)
from pycardano import certificate as certificates
from pycardano.backend.base import ChainContext, ProtocolParameters
from pycardano.cbor import cbor2
from pycardano.hash import ScriptHash
from pycardano.plutus import datum_hash, script_hash
from pycardano.serialization import NonEmptyOrderedSet, RawCBOR

SCHEMA = 1

# build() logs the builder's whole state as a warning when it raises
# (pycardano/logging.py, log_state), which would fill the worker's log; the
# library's logger writes errors only. The library still formats the state on
# every call, as it always does.
logging.getLogger("PyCardano").setLevel(logging.ERROR)

# The Conway ledger's reference-script fee tiers, as the node reports them
# (Ogmios v6 minFeeReferenceScripts and maxReferenceScriptsSize, which
# pycardano/backend/ogmios_v6.py:197-198 passes through): a 25,600-byte range
# whose price grows by 1.2, and a 204,800-byte limit per transaction.
REF_SCRIPT_RANGE = 25600
REF_SCRIPT_MULTIPLIER = 1.2
REF_SCRIPT_MAX = 204800

# The execution-unit limit per transaction. The run's parameters do not carry
# it; PyCardano reads it only in max_tx_fee (utils.py), which sizes the fee
# field of its first estimate (the same CBOR width for any limit near the
# networks') and its collateral amount, 150% of that maximum fee
# (txbuilder.py:1527-1531).
MAX_TX_EX_MEM = 16500000
MAX_TX_EX_STEPS = 10000000000


class NotReplayable(Exception):
    def __init__(self, part, why):
        super().__init__(why)
        self.part = part


class StageError(Exception):
    def __init__(self, stage, err):
        super().__init__(str(err))
        self.stage = stage
        self.err = err


# ---- CBOR items.


def _head(b, i):
    ib = b[i]
    mt, ai = ib >> 5, ib & 31
    i += 1
    if ai < 24:
        return mt, ai, i
    if ai in (24, 25, 26, 27):
        n = 1 << (ai - 24)
        return mt, int.from_bytes(b[i : i + n], "big"), i + n
    if ai == 31:
        return mt, None, i
    raise ValueError("malformed CBOR")


def _skip(b, i):
    mt, v, j = _head(b, i)
    if mt in (0, 1, 7):
        return j
    if mt == 6:
        return _skip(b, j)
    if v is None:
        while b[j] != 0xFF:
            j = _skip(b, j)
        return j + 1
    if mt in (2, 3):
        return j + v
    for _ in range(v * (2 if mt == 5 else 1)):
        j = _skip(b, j)
    return j


def items(b):
    """The items of a CBOR list or tag-258 set, each as its bytes."""
    mt, v, j = _head(b, 0)
    if mt == 6:
        mt, v, j = _head(b, j)
    if mt != 4:
        raise ValueError("expected a list")
    out = []
    while (v is None and b[j] != 0xFF) or (v is not None and len(out) < v):
        k = _skip(b, j)
        out.append(b[j:k])
        j = k
    return out


def _uint(n):
    if n < 24:
        return bytes([n])
    return bytes([24, n])


def body_of(fields):
    """The library's TransactionBody decoded from fixed body fields, each as
    its original bytes, beside empty inputs and outputs and a zero fee."""
    entries = {0: b"\x80", 1: b"\x80", 2: b"\x00"}
    entries.update(fields)
    raw = bytes([0xA0 + len(entries)]) + b"".join(_uint(k) + v for k, v in sorted(entries.items()))
    return TransactionBody.from_cbor(raw)


# The library's certificate types by their CDDL code: the Certificate union
# (certificate.py:632-649) and RegDRepCert, which the builder handles
# (txbuilder.py:915-916, :946-955) but the union leaves out. The library's
# TransactionBody decoding leaves the certificates of a tag-258 set as plain
# lists, which none of its deposit or witness counts recognize, so each such
# one is decoded by its code.
CERTIFICATE_TYPES = {}
for _cls in (*typing.get_args(certificates.Certificate), certificates.RegDRepCert):
    CERTIFICATE_TYPES[next(f.default for f in dataclasses.fields(_cls) if f.name == "_CODE")] = _cls


def certificate_of(value):
    if isinstance(value, tuple(CERTIFICATE_TYPES.values())):
        return value
    cls = CERTIFICATE_TYPES.get(value[0]) if isinstance(value, (list, tuple)) and value else None
    if cls is None:
        raise NotReplayable("certificates", f"a certificate of kind {value[0] if value else '?'}: the library has no type for it")
    return cls.from_primitive(list(value))


# ---- The chain context.


class ReplayContext(ChainContext):
    def __init__(self, params, epoch, network, slot, by_addr):
        self._pp = params
        self._epoch = epoch
        self._network = network
        self._slot = slot
        self._by_addr = by_addr

    @property
    def protocol_param(self):
        return self._pp

    @property
    def genesis_param(self):
        raise NotImplementedError("the simulator's chain context has no genesis parameters")

    @property
    def network(self):
        return self._network

    @property
    def epoch(self):
        if self._epoch is None:
            raise ValueError("the run states no epoch")
        return self._epoch

    @property
    def last_block_slot(self):
        if self._slot is None:
            raise ValueError("the spend has no slot for the builder's automatic validity interval")
        return self._slot

    def _utxos(self, address):
        return list(self._by_addr.get(address, []))

    def submit_tx_cbor(self, cbor):
        raise NotImplementedError("the simulator's chain context submits nothing")

    def evaluate_tx_cbor(self, cbor):
        raise NotImplementedError("the simulator's chain context evaluates nothing")


def _int(p, k):
    v = p.get(k)
    if v is None:
        raise ValueError(f"protocol parameter {k} is missing")
    return int(v)


def _rat(p, k):
    v = p.get(k)
    if v is None:
        return None
    return Fraction(int(v[0]), int(v[1]))


def protocol_params(p):
    """The run's parameters as PyCardano's (backend/base.py:41-130). The
    fields the builder never reads (block limits, pool and expansion rates,
    the pre-Alonzo minimum) are zero."""
    ref = _rat(p, "minFeeRefScriptCostPerByte")
    price_mem = _rat(p, "priceMem")
    price_step = _rat(p, "priceStep")
    return ProtocolParameters(
        min_fee_constant=_int(p, "minFeeB"),
        min_fee_coefficient=_int(p, "minFeeA"),
        max_block_size=0,
        max_tx_size=_int(p, "maxTxSize"),
        max_block_header_size=0,
        key_deposit=int(p["keyDeposit"]) if p.get("keyDeposit") is not None else 0,
        pool_deposit=int(p["poolDeposit"]) if p.get("poolDeposit") is not None else 0,
        pool_influence=Fraction(0),
        monetary_expansion=Fraction(0),
        treasury_expansion=Fraction(0),
        decentralization_param=Fraction(0),
        extra_entropy="",
        protocol_major_version=int(p["protocolMajor"]) if p.get("protocolMajor") is not None else 0,
        protocol_minor_version=0,
        min_utxo=0,
        min_pool_cost=0,
        price_mem=price_mem if price_mem is not None else Fraction(0),
        price_step=price_step if price_step is not None else Fraction(0),
        max_tx_ex_mem=MAX_TX_EX_MEM,
        max_tx_ex_steps=MAX_TX_EX_STEPS,
        max_block_ex_mem=0,
        max_block_ex_steps=0,
        max_val_size=_int(p, "maxValSize"),
        collateral_percent=_int(p, "collateralPercent"),
        max_collateral_inputs=_int(p, "maxCollateralInputs"),
        coins_per_utxo_word=0,
        coins_per_utxo_byte=_int(p, "coinsPerUtxoByte"),
        cost_models={},
        maximum_reference_scripts_size={"bytes": REF_SCRIPT_MAX} if ref is not None else None,
        min_fee_reference_scripts=(
            {"base": float(ref), "range": REF_SCRIPT_RANGE, "multiplier": REF_SCRIPT_MULTIPLIER} if ref is not None else None
        ),
    )


# ---- State across requests.

# The UTxO of every reference this process has been sent.
CACHE = {}
# The builder and body of the last build, which a witness request fills.
LAST = None


def utxo_of(hexstr):
    return UTxO.from_cbor(bytes.fromhex(hexstr))


def map_entries(b):
    """The entries of a CBOR map, each key and value as its bytes."""
    mt, v, j = _head(b, 0)
    if mt != 5:
        return None
    out = []
    while (v is None and b[j] != 0xFF) or (v is not None and len(out) < v):
        k = _skip(b, j)
        e = _skip(b, k)
        out.append((b[j:k], b[k:e]))
        j = e
    return out


def requested_output(raw):
    """A requested output as the library's TransactionOutput, holding the
    output's inline datum as its own bytes (RawCBOR, a Datum the library
    encodes as it is): the library's decoding turns a datum into its own
    Plutus data, which it writes back with every byte string over 64 bytes
    unchunked and definite lists made indefinite, which the ledger and
    cardano-serialization-lib refuse."""
    out = TransactionOutput.from_cbor(raw)
    for k, v in map_entries(raw) or []:
        if k == b"\x02":
            parts = items(v)
            if len(parts) == 2 and parts[0] == b"\x01":
                out.datum = RawCBOR(cbor2.loads(parts[1]).value)
    return out


def first_line(e):
    text = str(e).strip().split("\n")[0].strip()
    return f"{type(e).__name__}: {text}" if text else type(e).__name__


# ---- The replay's fixed parts.

BODY_FIELDS = {"3", "4", "5", "8", "9", "14", "19", "20", "21", "22"}
PLUTUS_KEYS = {"3": PlutusV1Script, "6": PlutusV2Script, "7": PlutusV3Script}


def with_fixed_parts(b, ctx, q, fixed):
    """The intent's fixed parts through the builder's operations. A part no
    operation writes is not replayable."""
    w = fixed.get("witnesses") or {}
    if "2" in w:
        raise NotReplayable("bootstrap witnesses", "a bootstrap witness: the builder has no operation that writes one")
    for k in fixed.get("body") or {}:
        if k not in BODY_FIELDS:
            raise NotReplayable(f"body field {k}", f"body field {k}: the builder has no operation that writes it")
    redeemers = fixed.get("redeemers") or []
    for r in redeemers:
        if r["tag"] in (4, 5):
            raise NotReplayable("plutus", f"a redeemer with tag {r['tag']} (a vote or a proposal): the builder attaches redeemers to spends, mints, withdrawals and certificates only")

    # Scripts by hash: the witness set's, then the reference scripts of the
    # reference inputs. A script input that carries its own script needs
    # neither (add_script_input, txbuilder.py:319-320).
    scripts = {}
    native = []
    if "1" in w:
        for item in items(bytes.fromhex(w["1"])):
            s = NativeScript.from_cbor(item)
            native.append(s)
            scripts[script_hash(s)] = s
    for k, cls in PLUTUS_KEYS.items():
        if k in w:
            for item in items(bytes.fromhex(w[k])):
                s = cls(cbor2.loads(item))
                scripts[script_hash(s)] = s
    refs = []
    for x in fixed.get("referenceInputs") or []:
        u = utxo_of(x["cbor"])
        refs.append(u)
    ref_scripts = {}
    for u in refs:
        if u.output.script is not None:
            ref_scripts.setdefault(script_hash(u.output.script), u)

    def source(h):
        """The script with hash h as an operation takes it: the script, or the
        reference input that carries it."""
        if h in scripts:
            return scripts[h]
        if h in ref_scripts:
            return ref_scripts[h]
        return None

    def redeemer(r):
        mem, steps = (int(x) for x in r["exUnits"])
        return Redeemer(RawCBOR(bytes.fromhex(r["data"])), ExecutionUnits(mem, steps))

    by_target = {}
    for r in redeemers:
        t = r["target"]
        key = {
            "input": lambda: ("input", t["ref"]),
            "policy": lambda: ("policy", t["policy"]),
            "certificate": lambda: ("certificate", t["index"]),
            "withdrawal": lambda: ("withdrawal", t["account"]),
        }[t["kind"]]()
        by_target[key] = r

    if native:
        b.native_scripts = native
    if "4" in w:
        for item in items(bytes.fromhex(w["4"])):
            d = RawCBOR(item)
            b.datums[datum_hash(d)] = d
    for u in refs:
        b.reference_inputs.add(u)

    for x in fixed.get("inputs") or []:
        u = utxo_of(x["cbor"])
        part = u.output.address.payment_part
        r = by_target.get(("input", x["ref"]))
        if isinstance(part, ScriptHash):
            src = source(part)
            if r is None and src is not None and isinstance(src, NativeScript):
                b.add_input(u)
            else:
                b.add_script_input(u, script=src, redeemer=redeemer(r) if r is not None else None)
        else:
            b.add_input(u)

    fields = {int(k): bytes.fromhex(v) for k, v in (fixed.get("body") or {}).items()}
    body = body_of(fields) if fields else None
    if body is not None:
        if body.ttl is not None:
            b.ttl = body.ttl
        if body.validity_start is not None:
            b.validity_start = body.validity_start
        if body.required_signers:
            b.required_signers = list(body.required_signers)
        if body.mint:
            b.mint = body.mint
            for policy in body.mint.keys():
                r = by_target.get(("policy", policy.payload.hex()))
                src = source(policy)
                # A native policy in the witness set is already among the
                # builder's native scripts; any other policy's script is
                # attached with its redeemer, if any.
                if r is not None or (src is not None and not (isinstance(src, NativeScript) and policy in scripts)):
                    b.add_minting_script(src, redeemer(r) if r is not None else None)
        if body.withdraws:
            b.withdrawals = body.withdraws
            for account in body.withdraws.keys():
                r = by_target.get(("withdrawal", bytes(account).hex()))
                if r is not None:
                    staking = Address.from_primitive(bytes(account)).staking_part
                    b.add_withdrawal_script(source(staking), redeemer(r))
        if body.certificates:
            certs = [certificate_of(c) for c in body.certificates]
            b.certificates = []
            for i, c in enumerate(certs):
                b.certificates.append(c)
                r = by_target.get(("certificate", i))
                if r is not None:
                    cred = getattr(c, "stake_credential", None) or getattr(c, "drep_credential", None)
                    b.add_certificate_script(source(cred.credential), redeemer(r))
        if body.voting_procedures:
            b.voting_procedures = body.voting_procedures
        if body.proposal_procedures:
            b.proposal_procedures = body.proposal_procedures
        if body.current_treasury_value is not None:
            b.current_treasury_value = body.current_treasury_value
        if body.donation is not None:
            b.add_treasury_donation(body.donation)

    # A Plutus script of the witness set reaches the transaction only through
    # the operation of the part it serves.
    used = {script_hash(s) for s in b.all_scripts}
    for h, s in scripts.items():
        if not isinstance(s, NativeScript) and h not in used:
            raise NotReplayable("plutus", "a Plutus script of the witness set that no redeemer uses: no operation writes it")

    aux = fixed.get("auxiliaryData")
    if aux is not None:
        b.auxiliary_data = AuxiliaryData.from_cbor(bytes.fromhex(aux))
    if fixed.get("refScriptBytes") and q["params"].get("minFeeRefScriptCostPerByte") is None:
        raise ValueError("protocol parameter minFeeRefScriptCostPerByte is not stated for this run")


# ---- The build.


def build(q):
    global LAST
    LAST = None
    try:
        params = protocol_params(q["params"])
        change = Address.decode(q["changeAddress"])
        network = Network.MAINNET if q["networkId"] == 1 else Network.TESTNET
    except Exception as e:
        raise StageError("replay parts", first_line(e))
    by_addr = {}
    addrs = []
    for x in q["utxos"]:
        if x.get("cbor") is not None:
            try:
                CACHE[x["ref"]] = utxo_of(x["cbor"])
            except Exception as e:
                raise StageError("replay parts", f"{x['ref']}: {first_line(e)}")
        u = CACHE.get(x["ref"])
        if u is None:
            raise StageError("replay parts", f"no bytes for {x['ref']}")
        a = str(u.output.address)
        if a not in by_addr:
            by_addr[a] = []
            addrs.append(u.output.address)
        by_addr[a].append(u)
    ctx = ReplayContext(params, q["params"].get("epoch"), network, (q.get("at") or {}).get("slot"), by_addr)
    b = TransactionBuilder(ctx)
    for a in addrs:
        b.add_input_address(a)
    for i, o in enumerate(q["outputs"]):
        try:
            b.add_output(requested_output(bytes.fromhex(o)))
        except Exception as e:
            raise StageError("requested output", f"output {i}: {first_line(e)}")
    intent = q.get("intent") or {}
    fixed = intent.get("fixed")
    if fixed is not None:
        try:
            with_fixed_parts(b, ctx, q, fixed)
        except NotReplayable:
            raise
        except Exception as e:
            raise StageError("replay parts", first_line(e))
    c = q.get("collateral")
    if c is not None:
        b.collaterals.append(utxo_of(c["cbor"]))
    if q.get("seed") is not None:
        random.seed(int(q["seed"]))
    try:
        body = b.build(change_address=change)
    except Exception as e:
        raise StageError("build", first_line(e))
    LAST = (b, body)
    tx = Transaction(body, b.build_witness_set(True), True, b.auxiliary_data)
    return tx.to_cbor().hex()


def witness(q):
    if LAST is None:
        raise ValueError("no transaction built")
    b, body = LAST
    ws = b.build_witness_set(True)
    ws.vkey_witnesses = NonEmptyOrderedSet([VerificationKeyWitness.from_cbor(bytes.fromhex(h)) for h in q["vkeys"]]) if q["vkeys"] else None
    tx = Transaction(body, ws, True, b.auxiliary_data)
    # The vkey witnesses the builder's fee priced (txbuilder.py:1091-1101).
    priced = b._witness_count()
    unpriced = ["observed vkey witnesses"] if q.get("observed", 0) > 0 and len(q["vkeys"]) > priced else None
    return tx.to_cbor().hex(), unpriced


def answer(q):
    if q.get("schema") != SCHEMA:
        return {"ok": False, "error": f"schema {q.get('schema')}, the helper's {SCHEMA}"}
    op = q.get("op")
    if op == "build":
        try:
            return {"ok": True, "tx": build(q)}
        except NotReplayable as e:
            return {"ok": False, "notReplayable": e.part, "error": str(e)}
        except StageError as e:
            return {"ok": False, "stage": e.stage, "error": str(e)}
    if op == "witness":
        try:
            tx, unpriced = witness(q)
        except Exception as e:
            return {"ok": False, "error": first_line(e)}
        r = {"ok": True, "tx": tx}
        if unpriced:
            r["unpriced"] = unpriced
        return r
    return {"ok": False, "error": f"unknown op {op}"}


def main():
    inp = sys.stdin.buffer
    out = sys.stdout.buffer
    for line in inp:
        if not line.strip():
            continue
        try:
            q = json.loads(line)
        except ValueError as e:
            sys.stderr.write(f"pycardano helper: a request that is not JSON: {e}\n")
            sys.exit(2)
        r = answer(q)
        r["id"] = q.get("id")
        out.write(json.dumps(r, separators=(",", ":")).encode("utf-8") + b"\n")
        out.flush()


if __name__ == "__main__":
    main()
