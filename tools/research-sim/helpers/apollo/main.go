// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The Apollo helper of the simulator's bridge (src/methods/helper.mjs, schema
// 1): it reads one request per line on stdin and writes one response per line
// on stdout, and exits at the end of its input.
//
// A build is Apollo's transaction builder at its defaults, called as a dapp
// calls it for a payment (github.com/Salvionied/apollo/v2 v2.2.1, commit
// 12d4a1c7; apollo.go:158, :224, :293, :260, :1875):
//
//	apollo.New(chainContext).SetWallet(wallet)
//	    .AddInputAddress(addr) for each of the wallet's addresses
//	    .AddPayment(output) for each requested output
//	    ...the replay's fixed parts through the builder's operations...
//	    .Complete()
//
// with no coin selector set, so Complete selects with the package's default,
// NewMACSSelector() (apollo.go:2640-2643, coinselection.go:57, macs.go:79-85):
// Apollo's MACS as shipped. The chain context is the request's: its protocol
// parameters, its network, and its UTxOs, which Utxos returns by address in
// the request's order and UtxoByRef by reference (with the fixed and reference
// inputs and the collateral set aside). The wallet's address is the change
// address, so Complete's change goes there (apollo.go:3859-3864). Each
// requested output enters as its own bytes (rawPayment), so its datum, script
// reference and coin pass through.
package main

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"os"
	"strconv"
	"strings"

	apollo "github.com/Salvionied/apollo/v2"
	"github.com/Salvionied/apollo/v2/backend"
	"github.com/blinklabs-io/gouroboros/cbor"
	"github.com/blinklabs-io/gouroboros/ledger/babbage"
	"github.com/blinklabs-io/gouroboros/ledger/common"
	"github.com/blinklabs-io/gouroboros/ledger/conway"
	"github.com/blinklabs-io/gouroboros/ledger/shelley"
)

const schema = 1

type refBytes struct {
	Ref  string  `json:"ref"`
	Cbor *string `json:"cbor"`
}

type fixedInput struct {
	Ref       string  `json:"ref"`
	Cbor      string  `json:"cbor"`
	WalletKey *string `json:"walletKey"`
	Held      *string `json:"held"`
}

type redeemer struct {
	Tag     int       `json:"tag"`
	Data    string    `json:"data"`
	ExUnits [2]string `json:"exUnits"`
}

type fixedParts struct {
	Inputs          []fixedInput      `json:"inputs"`
	ReferenceInputs []fixedInput      `json:"referenceInputs"`
	Body            map[string]string `json:"body"`
	Witnesses       map[string]string `json:"witnesses"`
	Redeemers       []redeemer        `json:"redeemers"`
	AuxiliaryData   *string           `json:"auxiliaryData"`
}

type request struct {
	Op            string            `json:"op"`
	Schema        int               `json:"schema"`
	ID            int64             `json:"id"`
	Library       string            `json:"library"`
	NetworkID     uint8             `json:"networkId"`
	At            struct{ Slot *int64 } `json:"at"`
	ChangeAddress string            `json:"changeAddress"`
	Utxos         []refBytes        `json:"utxos"`
	Outputs       []string          `json:"outputs"`
	Params        map[string]any    `json:"params"`
	Intent        struct {
		Source *string     `json:"source"`
		Fixed  *fixedParts `json:"fixed"`
	} `json:"intent"`
	Collateral *fixedInput `json:"collateral"`
	Vkeys      []string    `json:"vkeys"`
	Observed   int         `json:"observed"`
}

type response struct {
	ID            int64    `json:"id"`
	Ok            bool     `json:"ok"`
	Tx            string   `json:"tx,omitempty"`
	Error         string   `json:"error,omitempty"`
	Stage         string   `json:"stage,omitempty"`
	NotReplayable string   `json:"notReplayable,omitempty"`
	Unpriced      []string `json:"unpriced,omitempty"`
}

// notReplayable is a part the library has no operation for.
type notReplayable struct{ part, why string }

func (e notReplayable) Error() string { return e.why }

// stageError names where a build failed.
type stageError struct {
	stage string
	err   error
}

func (e stageError) Error() string { return e.err.Error() }

// The bytes of every reference this process has been sent, decoded.
var cache = map[string]common.Utxo{}

// The builder of the last build, whose transaction a witness request fills,
// and the number of vkey witnesses its fee priced.
var last *apollo.Apollo
var lastPriced int

func main() {
	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	out := bufio.NewWriter(os.Stdout)
	for {
		line, err := in.ReadBytes('\n')
		if len(line) > 0 {
			var q request
			var r response
			if jerr := json.Unmarshal(line, &q); jerr != nil {
				fmt.Fprintf(os.Stderr, "apollo helper: a request that is not JSON: %v\n", jerr)
				os.Exit(2)
			}
			r = answer(&q)
			r.ID = q.ID
			b, _ := json.Marshal(r)
			out.Write(b)
			out.WriteByte('\n')
			out.Flush()
		}
		if err != nil {
			return
		}
	}
}

func answer(q *request) response {
	if q.Schema != schema {
		return response{Ok: false, Error: fmt.Sprintf("schema %d, the helper's %d", q.Schema, schema)}
	}
	switch q.Op {
	case "build":
		tx, err := build(q)
		if err != nil {
			var nr notReplayable
			if errors.As(err, &nr) {
				return response{Ok: false, NotReplayable: nr.part, Error: nr.why}
			}
			var se stageError
			if errors.As(err, &se) {
				return response{Ok: false, Stage: se.stage, Error: se.err.Error()}
			}
			return response{Ok: false, Error: err.Error()}
		}
		return response{Ok: true, Tx: tx}
	case "witness":
		tx, err := witness(q)
		if err != nil {
			return response{Ok: false, Error: err.Error()}
		}
		// The observed vkey witnesses outnumber the keys the fee priced.
		if q.Observed > 0 && len(q.Vkeys) > lastPriced {
			return response{Ok: true, Tx: tx, Unpriced: []string{"observed vkey witnesses"}}
		}
		return response{Ok: true, Tx: tx}
	}
	return response{Ok: false, Error: "unknown op " + q.Op}
}

// ---- Decoding.

func unhex(s string) ([]byte, error) { return hex.DecodeString(s) }

// A TransactionUnspentOutput [input, output] as Apollo's UTxO.
func decodeUtxo(cborHex string) (common.Utxo, error) {
	b, err := unhex(cborHex)
	if err != nil {
		return common.Utxo{}, err
	}
	var pair []cbor.RawMessage
	if _, err := cbor.Decode(b, &pair); err != nil || len(pair) != 2 {
		return common.Utxo{}, fmt.Errorf("TransactionUnspentOutput: %v", err)
	}
	var in shelley.ShelleyTransactionInput
	if _, err := cbor.Decode(pair[0], &in); err != nil {
		return common.Utxo{}, fmt.Errorf("TransactionUnspentOutput input: %w", err)
	}
	out, err := babbage.NewBabbageTransactionOutputFromCbor(pair[1])
	if err != nil {
		return common.Utxo{}, err
	}
	return common.Utxo{Id: in, Output: out}, nil
}

func refOf(u common.Utxo) string {
	return hex.EncodeToString(u.Id.Id().Bytes()) + "#" + strconv.Itoa(int(u.Id.Index()))
}

// ---- The chain context.

type chain struct {
	pp     backend.ProtocolParameters
	net    uint8
	epoch  uint64
	slot   uint64
	byAddr map[string][]common.Utxo
	byRef  map[string]common.Utxo
}

func (c *chain) Capabilities() backend.CapabilitySet {
	return backend.CapabilitySet(backend.CapabilityProtocolParams | backend.CapabilityGenesisParams | backend.CapabilityCurrentEpoch |
		backend.CapabilityMaxTxFee | backend.CapabilityTip | backend.CapabilityUtxos | backend.CapabilityUtxoByRef)
}
func (c *chain) ProtocolParams() (backend.ProtocolParameters, error) { return c.pp, nil }
func (c *chain) GenesisParams() (backend.GenesisParameters, error) {
	return backend.GenesisParameters{}, nil
}
func (c *chain) NetworkId() uint8                 { return c.net }
func (c *chain) CurrentEpoch() (uint64, error)    { return c.epoch, nil }
func (c *chain) MaxTxFee() (uint64, error)        { return backend.ComputeMaxTxFee(c.pp) }
func (c *chain) Tip() (uint64, error)             { return c.slot, nil }
func (c *chain) Utxos(a common.Address) ([]common.Utxo, error) {
	src := c.byAddr[a.String()]
	out := make([]common.Utxo, len(src))
	copy(out, src)
	return out, nil
}
func (c *chain) SubmitTx([]byte) (common.Blake2b256, error) {
	return common.Blake2b256{}, backend.NewUnsupportedError("the simulator's chain context", backend.CapabilitySubmitTx)
}
func (c *chain) EvaluateTx([]byte, []common.Utxo) (map[common.RedeemerKey]common.ExUnits, error) {
	return nil, backend.NewUnsupportedError("the simulator's chain context", backend.CapabilityEvaluateTx)
}
func (c *chain) UtxoByRef(h common.Blake2b256, i uint32) (*common.Utxo, error) {
	u, ok := c.byRef[hex.EncodeToString(h.Bytes())+"#"+strconv.Itoa(int(i))]
	if !ok {
		return nil, errors.New("utxo not found in the simulator's chain context")
	}
	return &u, nil
}
func (c *chain) ScriptCbor(common.Blake2b224) ([]byte, error) {
	return nil, backend.NewUnsupportedError("the simulator's chain context", backend.CapabilityScriptCbor)
}

// The run's parameters as Apollo's (backend/base.go:211-259).
func protocolParams(p map[string]any) (backend.ProtocolParameters, error) {
	str := func(k string) string {
		if v, ok := p[k].(string); ok {
			return v
		}
		return ""
	}
	i64 := func(k string) (int64, error) {
		s := str(k)
		if s == "" {
			if f, ok := p[k].(float64); ok {
				return int64(f), nil
			}
			return 0, fmt.Errorf("parameter %s missing", k)
		}
		return strconv.ParseInt(s, 10, 64)
	}
	rat := func(k string) (*big.Rat, bool) {
		a, ok := p[k].([]any)
		if !ok || len(a) != 2 {
			return nil, false
		}
		n, _ := new(big.Int).SetString(fmt.Sprint(a[0]), 10)
		d, _ := new(big.Int).SetString(fmt.Sprint(a[1]), 10)
		if n == nil || d == nil || d.Sign() == 0 {
			return nil, false
		}
		return new(big.Rat).SetFrac(n, d), true
	}
	var pp backend.ProtocolParameters
	var err error
	if pp.MinFeeCoefficient, err = i64("minFeeA"); err != nil {
		return pp, err
	}
	if pp.MinFeeConstant, err = i64("minFeeB"); err != nil {
		return pp, err
	}
	mts, err := i64("maxTxSize")
	if err != nil {
		return pp, err
	}
	pp.MaxTxSize = int(mts)
	mvs, err := i64("maxValSize")
	if err != nil {
		return pp, err
	}
	pp.MaxValSize = strconv.FormatInt(mvs, 10)
	cpb, err := i64("coinsPerUtxoByte")
	if err != nil {
		return pp, err
	}
	pp.CoinsPerUtxoByte = strconv.FormatInt(cpb, 10)
	cp, err := i64("collateralPercent")
	if err != nil {
		return pp, err
	}
	pp.CollateralPercent = int(cp)
	mci, err := i64("maxCollateralInputs")
	if err != nil {
		return pp, err
	}
	pp.MaxCollateralInputs = int(mci)
	pp.KeyDeposits = str("keyDeposit")
	pp.PoolDeposits = str("poolDeposit")
	if r, ok := rat("priceMem"); ok {
		pp.PriceMem, _ = r.Float64()
	}
	if r, ok := rat("priceStep"); ok {
		pp.PriceStep, _ = r.Float64()
	}
	if r, ok := rat("minFeeRefScriptCostPerByte"); ok {
		pp.MinFeeRefScriptCostPerByteRational = r
		pp.MinFeeRefScriptCostPerByte, _ = r.Float64()
	}
	if v, err := i64("protocolMajor"); err == nil {
		pp.ProtocolMajorVersion = int(v)
	}
	return pp, nil
}

// ---- The wallet.

// The wallet Apollo is given: its address is the change address. It signs
// nothing; the bridge has the synthetic witnesses written after the build.
type wallet struct{ addr common.Address }

func (w wallet) Address() common.Address { return w.addr }
func (w wallet) SignTxBody(common.Blake2b256) (common.VkeyWitness, error) {
	return common.VkeyWitness{}, errors.New("the simulator's wallet signs nothing")
}
func (w wallet) PubKeyHash() common.Blake2b224      { return w.addr.PaymentKeyHash() }
func (w wallet) StakePubKeyHash() common.Blake2b224 { return w.addr.StakeKeyHash() }

// ---- Requested outputs.

// A requested output as its own bytes: Apollo's PaymentI over the decoded
// output (models.go:103-114). Its coin is the history reader's, already at
// least the output's minimum, so EnsureMinUTXO leaves it as it is.
type rawPayment struct{ out *babbage.BabbageTransactionOutput }

func (p rawPayment) EnsureMinUTXO(backend.ChainContext) error { return nil }
func (p rawPayment) ToTxOut() (common.TransactionOutput, error) {
	return p.out, nil
}
func (p rawPayment) ToValue() (apollo.Value, error) {
	return apollo.ValueFromMaryValue(p.out.OutputAmount), nil
}

// ---- The build.

func build(q *request) (string, error) {
	last = nil
	pp, err := protocolParams(q.Params)
	if err != nil {
		return "", stageError{"replay parts", err}
	}
	change, err := common.NewAddress(q.ChangeAddress)
	if err != nil {
		return "", stageError{"replay parts", fmt.Errorf("change address: %w", err)}
	}
	c := &chain{pp: pp, net: q.NetworkID, byAddr: map[string][]common.Utxo{}, byRef: map[string]common.Utxo{}}
	if v, ok := q.Params["epoch"].(float64); ok {
		c.epoch = uint64(v)
	}
	if q.At.Slot != nil && *q.At.Slot > 0 {
		c.slot = uint64(*q.At.Slot)
	}
	// The wallet's UTxOs, by address in the request's order.
	var addrs []common.Address
	for _, u := range q.Utxos {
		if u.Cbor != nil {
			d, err := decodeUtxo(*u.Cbor)
			if err != nil {
				return "", stageError{"replay parts", fmt.Errorf("%s: %w", u.Ref, err)}
			}
			cache[u.Ref] = d
		}
		d, ok := cache[u.Ref]
		if !ok {
			return "", stageError{"replay parts", fmt.Errorf("no bytes for %s", u.Ref)}
		}
		a := d.Output.Address()
		k := a.String()
		if _, seen := c.byAddr[k]; !seen {
			addrs = append(addrs, a)
		}
		c.byAddr[k] = append(c.byAddr[k], d)
		c.byRef[u.Ref] = d
	}
	a := apollo.New(c).SetWallet(wallet{addr: change})
	for _, addr := range addrs {
		a = a.AddInputAddress(addr)
	}
	for i, o := range q.Outputs {
		b, err := unhex(o)
		if err != nil {
			return "", stageError{"requested output", err}
		}
		out, err := babbage.NewBabbageTransactionOutputFromCbor(b)
		if err != nil {
			return "", stageError{"requested output", fmt.Errorf("output %d: %w", i, err)}
		}
		a = a.AddPayment(rawPayment{out: out})
	}
	if q.Intent.Fixed != nil {
		if a, err = withFixedParts(a, c, q); err != nil {
			return "", err
		}
	}
	built, err := a.Complete()
	if err != nil {
		return "", stageError{"Complete", err}
	}
	tx, err := built.GetTxCbor()
	if err != nil {
		return "", stageError{"Complete", err}
	}
	last = built
	lastPriced = pricedWitnesses(built, c, change)
	return hex.EncodeToString(tx), nil
}

// The vkey witnesses Complete() priced: the count of estimatedWitnessCount
// (apollo.go:2754-2833), which the library does not export, over the built
// transaction: the wallet's key, the required signers, the payment keys of
// the key-addressed inputs and collateral, and the stake keys of the
// withdrawals and of the stake certificates; at least one more than the
// required signers. It only names a part in a failure's detail.
func pricedWitnesses(a *apollo.Apollo, c *chain, w common.Address) int {
	tx := a.GetTx()
	if tx == nil {
		return 0
	}
	signers := map[common.Blake2b224]struct{}{w.PaymentKeyHash(): {}}
	reqs := tx.Body.TxRequiredSigners.Items()
	for _, h := range reqs {
		signers[h] = struct{}{}
	}
	addPayment := func(ins []shelley.ShelleyTransactionInput) {
		for _, i := range ins {
			u, ok := c.byRef[hex.EncodeToString(i.TxId.Bytes())+"#"+strconv.Itoa(int(i.OutputIndex))]
			if !ok || u.Output == nil {
				continue
			}
			addr := u.Output.Address()
			switch addr.Type() {
			case common.AddressTypeKeyKey, common.AddressTypeKeyScript, common.AddressTypeKeyPointer, common.AddressTypeKeyNone:
				if h := addr.PaymentKeyHash(); h != (common.Blake2b224{}) {
					signers[h] = struct{}{}
				}
			}
		}
	}
	addPayment(tx.Body.TxInputs.Items())
	addPayment(tx.Body.TxCollateral.Items())
	for acct := range tx.Body.TxWithdrawals {
		if h := acct.StakeKeyHash(); h != (common.Blake2b224{}) {
			signers[h] = struct{}{}
		}
	}
	stake := func(cr common.Credential) {
		if cr.CredType == common.CredentialTypeAddrKeyHash && cr.Credential != (common.Blake2b224{}) {
			signers[cr.Credential] = struct{}{}
		}
	}
	for _, wr := range tx.Body.TxCertificates {
		switch cert := wr.Certificate.(type) {
		case *common.StakeRegistrationCertificate:
			stake(cert.StakeCredential)
		case *common.StakeDeregistrationCertificate:
			stake(cert.StakeCredential)
		case *common.StakeDelegationCertificate:
			if cert.StakeCredential != nil {
				stake(*cert.StakeCredential)
			}
		case *common.RegistrationCertificate:
			stake(cert.StakeCredential)
		case *common.DeregistrationCertificate:
			stake(cert.StakeCredential)
		case *common.VoteDelegationCertificate:
			stake(cert.StakeCredential)
		case *common.StakeVoteDelegationCertificate:
			stake(cert.StakeCredential)
		case *common.StakeRegistrationDelegationCertificate:
			stake(cert.StakeCredential)
		case *common.VoteRegistrationDelegationCertificate:
			stake(cert.StakeCredential)
		case *common.StakeVoteRegistrationDelegationCertificate:
			stake(cert.StakeCredential)
		}
	}
	n := len(signers)
	if m := 1 + len(reqs); n < m {
		n = m
	}
	return n
}

// The vkey witnesses written into the last built transaction through the
// library (apollo.go:1341-1366), which encodes them as a tag-258 set.
func witness(q *request) (string, error) {
	if last == nil {
		return "", errors.New("no transaction built")
	}
	for i, h := range q.Vkeys {
		b, err := unhex(h)
		if err != nil {
			return "", err
		}
		var w common.VkeyWitness
		if _, err := cbor.Decode(b, &w); err != nil {
			return "", fmt.Errorf("vkey witness %d: %w", i, err)
		}
		if _, err := last.AddVerificationKeyWitness(w); err != nil {
			return "", err
		}
	}
	tx, err := last.GetTxCbor()
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(tx), nil
}

// ---- The replay's fixed parts.

func field(f *fixedParts, k int) ([]byte, bool, error) {
	h, ok := f.Body[strconv.Itoa(k)]
	if !ok {
		return nil, false, nil
	}
	b, err := unhex(h)
	return b, true, err
}

func uintField(f *fixedParts, k int) (uint64, bool, error) {
	b, ok, err := field(f, k)
	if !ok || err != nil {
		return 0, ok, err
	}
	var v uint64
	_, err = cbor.Decode(b, &v)
	return v, true, err
}

// The intent's fixed parts through the builder's operations. A part no
// operation writes is not replayable.
func withFixedParts(a *apollo.Apollo, c *chain, q *request) (*apollo.Apollo, error) {
	f := q.Intent.Fixed
	fail := func(err error) (*apollo.Apollo, error) { return a, stageError{"replay parts", err} }
	for k := range f.Witnesses {
		switch k {
		case "0", "1", "4":
		case "2":
			return a, notReplayable{"bootstrap witnesses", "a bootstrap witness: the builder has no operation that writes one"}
		default:
			return a, notReplayable{"plutus", "a Plutus script, datum or redeemer: the adapter's path for Plutus parts is not built"}
		}
	}
	for k := range f.Body {
		switch k {
		case "3", "4", "5", "8", "9", "14", "19", "20", "21", "22":
		default:
			return a, notReplayable{"body field " + k, "body field " + k + ": the builder has no operation that writes it"}
		}
	}
	if len(f.Redeemers) > 0 {
		return a, notReplayable{"plutus", "a redeemer: the adapter's path for Plutus parts is not built"}
	}
	// Native scripts of the witness set, attached for the parts that need
	// them (fixed inputs, mint, certificates, withdrawals).
	if h, ok := f.Witnesses["1"]; ok {
		b, err := unhex(h)
		if err != nil {
			return fail(err)
		}
		var scripts cbor.SetType[common.NativeScript]
		if _, err := cbor.Decode(b, &scripts); err != nil {
			return fail(fmt.Errorf("native scripts: %w", err))
		}
		for _, s := range scripts.Items() {
			a = a.AttachScript(s)
		}
	}
	// Datums of the witness set (other datums, with no redeemer), each as
	// decoded (apollo.go:432-441).
	if h, ok := f.Witnesses["4"]; ok {
		b, err := unhex(h)
		if err != nil {
			return fail(err)
		}
		var datums cbor.SetType[common.Datum]
		if _, err := cbor.Decode(b, &datums); err != nil {
			return fail(fmt.Errorf("datums: %w", err))
		}
		for _, d := range datums.Items() {
			a = a.AddDatum(&d)
		}
	}
	for _, x := range f.Inputs {
		u, err := decodeUtxo(x.Cbor)
		if err != nil {
			return fail(fmt.Errorf("fixed input %s: %w", x.Ref, err))
		}
		c.byRef[x.Ref] = u
		a = a.AddInput(u)
	}
	for _, x := range f.ReferenceInputs {
		u, err := decodeUtxo(x.Cbor)
		if err != nil {
			return fail(fmt.Errorf("reference input %s: %w", x.Ref, err))
		}
		c.byRef[x.Ref] = u
		i := strings.IndexByte(x.Ref, '#')
		ix, _ := strconv.Atoi(x.Ref[i+1:])
		if a, err = a.AddReferenceInput(x.Ref[:i], ix); err != nil {
			return fail(err)
		}
	}
	if v, ok, err := uintField(f, 3); err != nil {
		return fail(err)
	} else if ok {
		if v > math.MaxInt64 {
			return fail(errors.New("TTL out of range"))
		}
		a = a.SetTtl(int64(v))
	}
	if v, ok, err := uintField(f, 8); err != nil {
		return fail(err)
	} else if ok {
		if v > math.MaxInt64 {
			return fail(errors.New("validity start out of range"))
		}
		a = a.SetValidityStart(int64(v))
	}
	if b, ok, err := field(f, 14); err != nil {
		return fail(err)
	} else if ok {
		var signers cbor.SetType[common.Blake2b224]
		if _, err := cbor.Decode(b, &signers); err != nil {
			return fail(fmt.Errorf("required signers: %w", err))
		}
		for _, h := range signers.Items() {
			a = a.AddRequiredSigner(h)
		}
	}
	if b, ok, err := field(f, 9); err != nil {
		return fail(err)
	} else if ok {
		var m common.MultiAsset[common.MultiAssetTypeMint]
		if _, err := cbor.Decode(b, &m); err != nil {
			return fail(fmt.Errorf("mint: %w", err))
		}
		for _, p := range m.Policies() {
			for _, n := range m.Assets(p) {
				q := m.Asset(p, n)
				if q == nil || !q.IsInt64() {
					return fail(errors.New("mint quantity out of range"))
				}
				a = a.Mint(apollo.Unit{PolicyId: hex.EncodeToString(p.Bytes()), Name: hex.EncodeToString(n), Quantity: q.Int64()}, nil, nil)
			}
		}
	}
	if b, ok, err := field(f, 4); err != nil {
		return fail(err)
	} else if ok {
		var certs cbor.SetType[common.CertificateWrapper]
		if _, err := cbor.Decode(b, &certs); err != nil {
			return fail(fmt.Errorf("certificates: %w", err))
		}
		a = a.SetCertificates(certs.Items())
	}
	if b, ok, err := field(f, 5); err != nil {
		return fail(err)
	} else if ok {
		var w map[cbor.ByteString]uint64
		if _, err := cbor.Decode(b, &w); err != nil {
			return fail(fmt.Errorf("withdrawals: %w", err))
		}
		for k, v := range w {
			addr, err := common.NewAddressFromBytes(k.Bytes())
			if err != nil {
				return fail(fmt.Errorf("withdrawal account: %w", err))
			}
			a = a.AddWithdrawal(addr, v, nil, nil)
		}
	}
	if b, ok, err := field(f, 19); err != nil {
		return fail(err)
	} else if ok {
		var votes common.VotingProcedures
		if _, err := cbor.Decode(b, &votes); err != nil {
			return fail(fmt.Errorf("votes: %w", err))
		}
		for voter, actions := range votes {
			for id, p := range actions {
				a = a.AddVote(*voter, *id, p)
			}
		}
	}
	if b, ok, err := field(f, 20); err != nil {
		return fail(err)
	} else if ok {
		var props cbor.SetType[conway.ConwayProposalProcedure]
		if _, err := cbor.Decode(b, &props); err != nil {
			return fail(fmt.Errorf("proposals: %w", err))
		}
		for _, p := range props.Items() {
			a = a.AddProposal(p)
		}
	}
	if v, ok, err := uintField(f, 21); err != nil {
		return fail(err)
	} else if ok {
		a = a.SetCurrentTreasuryValue(int64(v))
	}
	if v, ok, err := uintField(f, 22); err != nil {
		return fail(err)
	} else if ok {
		a = a.AddTreasuryDonation(int64(v))
	}
	if f.AuxiliaryData != nil {
		b, err := unhex(*f.AuxiliaryData)
		if err != nil {
			return fail(err)
		}
		aux, err := common.DecodeAuxiliaryData(b)
		if err != nil {
			return fail(fmt.Errorf("auxiliary data: %w", err))
		}
		if s, _ := aux.NativeScripts(); len(s) > 0 {
			return a, notReplayable{"auxiliary scripts", "auxiliary data holding scripts: the builder writes metadata only (apollo.go:1132-1135)"}
		}
		md, err := aux.Metadata()
		if err != nil {
			return fail(fmt.Errorf("metadata: %w", err))
		}
		if md != nil {
			mm, ok := md.(common.MetaMap)
			if !ok {
				if p, isPtr := md.(*common.MetaMap); isPtr {
					mm, ok = *p, true
				}
			}
			if !ok {
				return fail(fmt.Errorf("metadata is a %s, not a map", md.TypeName()))
			}
			labels := make(map[uint64]any, len(mm.Pairs))
			for _, p := range mm.Pairs {
				k, isInt := p.Key.(common.MetaInt)
				if !isInt || k.Value == nil || !k.Value.IsUint64() {
					return fail(errors.New("metadata label is not an unsigned integer"))
				}
				labels[k.Value.Uint64()] = p.Value
			}
			a = a.SetShelleyMetadata(labels)
		}
	}
	return a, nil
}
