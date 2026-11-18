// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Scalus 1.5.0 (org.scalus:scalus-cardano-ledger_3, the release tag v1.5.0,
// commit 5bf331b), called as a dapp calls it for a payment:
//
//   TxBuilder(env, evaluator)
//     .output(o) for each requested output, from its own bytes
//     ...the replay's fixed parts as the builder's own steps (addSteps)...
//     .complete(availableUtxos, sponsor)
//
// with the wallet's address (the change address) as the sponsor and the
// wallet's spendable UTxOs as availableUtxos, a Scala immutable Map built from
// them in the state's order (TxBuilder.scala:1649; paths in
// scalus-cardano-ledger/shared/src/main/scala/scalus/cardano/txbuilder/ at
// 5bf331b). complete keeps the UTxOs at the sponsor address not already spent
// by a step (:1670-1673), selects with UtxoPool.selectForValue on each
// balancing shortfall, at most ten rounds (:1700-1851, UtxoPool.scala:72-139),
// and writes one change output at the sponsor holding every surplus asset
// (Change.scala:28-60). The Map is the library's own input type, so its
// iteration order is the Map's: insertion order up to four entries, the hash
// order of the TransactionInput keys beyond. Scalus draws nothing at random.
//
// The environment is CardanoInfo with the run's protocol parameters over the
// library's bundled ones (CardanoInfo.mainnet's, whose cost models the run
// does not state) and the network of the change address. Scripts are not run:
// the evaluator answers each redeemer of the draft with the intent's observed
// execution units for the part its index names, in the ledger's ordering of
// the draft (sorted inputs, sorted policies, the certificate's place, sorted
// reward accounts, sorted voters, the proposal's place).
//
// Collateral is the library's own: complete selects it from the sponsor's
// UTxOs whenever the transaction carries a redeemer (:1676-1688,
// UtxoPool.scala:168-240) and has no way to take a UTxO chosen elsewhere in
// its place, so the method chooses its own collateral (contract.mjs
// OWN_COLLATERAL_METHODS).
package unfrackit.helper

import io.bullet.borer.Cbor
import scalus.cardano.address.{Address, Network}
import scalus.cardano.onchain.plutus.ScriptContext
import scalus.uplc.DebugScript
import scalus.cardano.ledger.*
import scalus.cardano.txbuilder.*
import scalus.cardano.txbuilder.TransactionBuilderStep as Step
import scalus.uplc.builtin.{ByteString, Data}

object ScalusLib:

  def decodeOutput(b: Array[Byte]): TransactionOutput = Cbor.decode(b).to[TransactionOutput].value

  def decodeUtxo(b: Array[Byte]): Utxo =
    val (i, o) = CborBytes.pair(b)
    Utxo(Cbor.decode(i).to[TransactionInput].value, decodeOutput(o))

  /** The run's protocol parameters over the library's bundled ones. */
  def cardanoInfo(q: Request): CardanoInfo =
    val base = if q.networkId == 1 then CardanoInfo.mainnet else CardanoInfo.preprod
    val p = base.protocolParams
    def interval(k: String, dflt: NonNegativeInterval) = q.rational(k) match
      case Some((n, d)) => NonNegativeInterval(n.toLong, d.toLong)
      case None => dflt
    val refPrice = q.rational("minFeeRefScriptCostPerByte") match
      case Some((n, d)) => (n / d).toLong
      case None => p.minFeeRefScriptCostPerByte
    val pp = p.copy(
      txFeePerByte = q.param("minFeeA"),
      txFeeFixed = q.param("minFeeB"),
      maxTxSize = q.param("maxTxSize"),
      maxValueSize = q.param("maxValSize"),
      utxoCostPerByte = q.param("coinsPerUtxoByte"),
      collateralPercentage = q.paramOpt("collateralPercent").getOrElse(p.collateralPercentage),
      maxCollateralInputs = q.paramOpt("maxCollateralInputs").getOrElse(p.maxCollateralInputs),
      executionUnitPrices = ExUnitPrices(interval("priceMem", p.executionUnitPrices.priceMemory), interval("priceStep", p.executionUnitPrices.priceSteps)),
      minFeeRefScriptCostPerByte = refPrice,
      stakeAddressDeposit = q.paramOpt("keyDeposit").getOrElse(p.stakeAddressDeposit),
      stakePoolDeposit = q.paramOpt("poolDeposit").getOrElse(p.stakePoolDeposit),
      dRepDeposit = q.paramOpt("drepDeposit").getOrElse(p.dRepDeposit),
      govActionDeposit = q.paramOpt("govActionDeposit").getOrElse(p.govActionDeposit)
    )
    base.copy(protocolParams = pp, network = if q.networkId == 1 then Network.Mainnet else Network.Testnet)

  /** The part a redeemer redeems, as a key both the intent's and the draft's
    * redeemers are named by. */
  private type Target = (String, Any)

  /** The evaluator: the intent's observed units for each redeemer of the
    * draft, found by the part its index names in the draft. */
  final class Observed(units: Map[Target, ExUnits]) extends PlutusScriptEvaluator:
    def evalPlutusScriptsWithContexts(tx: Transaction, utxos: Utxos, debugScripts: Map[ScriptHash, DebugScript]): Seq[(Redeemer, ScriptContext, ScriptHash)] =
      throw new UnsupportedOperationException("the simulator's evaluator returns redeemers only")

    override def evalPlutusScripts(tx: Transaction, utxos: Utxos, debugScripts: Map[ScriptHash, DebugScript]): Seq[Redeemer] =
      val body = tx.body.value
      val rs = tx.witnessSet.redeemers.map(_.value.toSeq).getOrElse(Seq.empty)
      rs.map { r =>
        val i = r.index
        val target: Target = r.tag match
          case RedeemerTag.Spend => ("spend", body.inputs.toSeq.lift(i).orNull)
          case RedeemerTag.Mint => ("mint", body.mint.map(_.assets.keys.toSeq).getOrElse(Seq.empty).lift(i).orNull)
          case RedeemerTag.Cert => ("cert", i)
          case RedeemerTag.Reward => ("reward", body.withdrawals.map(_.withdrawals.keys.toSeq).getOrElse(Seq.empty).lift(i).orNull)
          case RedeemerTag.Voting => ("vote", body.votingProcedures.map(_.procedures.keys.toSeq).getOrElse(Seq.empty).lift(i).orNull)
          case RedeemerTag.Proposing => ("propose", i)
        val u = units.getOrElse(target, throw new IllegalStateException(s"the draft's redeemer ${r.tag}:$i has no observed redeemer"))
        r.copy(exUnits = u)
      }

  private def bytesItem(hex: String): Array[Byte] =
    val b = Main.unhex(hex)
    CborBytes.head(2, b.length) ++ b

  def build(q: Request): (Array[Byte], Built) =
    val env = try cardanoInfo(q) catch case e: Exception => throw StageError("replay parts", e)
    val sponsor = try Address.fromBech32(q.changeAddress) catch case e: Exception => throw StageError("replay parts", e)
    val wallet = q.utxos.map(u => try decodeUtxo(u.cbor) catch case e: Exception => throw StageError("replay parts", new IllegalArgumentException(s"${u.ref}: ${Main.text(e)}")))
    val units = scala.collection.mutable.HashMap[Target, ExUnits]()
    var steps = Vector[Step]()
    var datums = Vector[Data]()
    var aux: Option[AuxiliaryData] = None
    q.outputs.zipWithIndex.foreach { case (o, i) =>
      try steps :+= Step.Send(decodeOutput(o))
      catch case e: Exception => throw StageError("requested output", new IllegalArgumentException(s"output $i: ${Main.text(e)}"))
    }
    q.fixed.foreach { f =>
      try
        val (s, d, a) = fixedSteps(f, units)
        steps ++= s
        datums ++= d
        aux = a
      catch
        case e: NotReplayable => throw e
        case e: Exception => throw StageError("replay parts", e)
    }
    var b = TxBuilder(env, Observed(units.toMap)).addSteps(steps*)
    datums.foreach(d => b = b.attach(d))
    aux.foreach(a => b = b.metadata(a))
    val available: Utxos = wallet.map(u => u.input -> u.output).toMap
    val done =
      try b.complete(available, sponsor)
      catch case e: Exception => throw StageError("complete", e)
    val tx = done.transaction
    // complete can return a change output holding a negative quantity of an
    // asset the selected inputs do not cover, when its lovelace still meets
    // the output's minimum (Change.scala:28-60 tests the lovelace only); such
    // a transaction does not balance, and the library's build is a failure.
    for (o, i) <- tx.body.value.outputs.zipWithIndex; (policy, assets) <- o.value.value.assets.assets; (name, q) <- assets if q < 0 do
      throw StageError("complete", new IllegalStateException(s"complete returned output $i holding a negative quantity $q of ${policy.toHex}.${name.bytes.toHex}"))
    val pricedCount = done.context.expectedSigners.size
    val built = new Built:
      def priced: Int = pricedCount
      def withVkeys(vkeys: Seq[Array[Byte]]): Array[Byte] =
        val ws = vkeys.map { v =>
          val (k, s) = CborBytes.pair(v)
          val key = Cbor.decode(k).to[ByteString].value
          val sig = Cbor.decode(s).to[ByteString].value
          VKeyWitness(key, sig)
        }
        tx.withWitness(w => w.copy(vkeyWitnesses = TaggedSortedSet.from(ws))).toCbor
    (tx.toCbor, built)

  /** The intent's fixed parts as the builder's steps, the datums of the
    * witness set no spend takes, and the auxiliary data. */
  private def fixedSteps(f: Fixed, units: scala.collection.mutable.HashMap[Target, ExUnits]): (Seq[Step], Seq[Data], Option[AuxiliaryData]) =
    for k <- f.witnesses.keys do
      k match
        case 0 | 1 | 3 | 4 | 5 | 6 | 7 =>
        case 2 => throw NotReplayable("bootstrap witnesses", "a bootstrap witness: the builder has no step that writes one")
        case _ => throw NotReplayable(s"witness set key $k", s"witness set key $k: the builder has no step that writes it")
    for k <- f.body.keys do
      k match
        case 3 | 4 | 5 | 8 | 9 | 14 | 19 | 20 | 21 | 22 =>
        case _ => throw NotReplayable(s"body field $k", s"body field $k: the builder has no step that writes it")
    // The fixed body fields and witness set entries, read with the library's
    // own decoders.
    // A transaction of the fixed parts, with one placeholder input and no
    // output, read by the library's own decoder.
    val placeholderInput = Array(0x81.toByte, 0x82.toByte, 0x58.toByte, 0x20.toByte) ++ new Array[Byte](32) ++ Array(0.toByte)
    val fake = Array(0x84.toByte) ++
      CborBytes.map(Seq(0 -> placeholderInput, 1 -> Array(0x80.toByte), 2 -> Array(0.toByte)) ++ f.body.toSeq.sortBy(_._1)) ++
      CborBytes.map(f.witnesses.toSeq.filter(_._1 != 0).sortBy(_._1)) ++ Array(0xf5.toByte, 0xf6.toByte)
    val read = Transaction.fromCbor(fake)
    val body = read.body.value
    val ws = read.witnessSet
    val scripts: Map[ScriptHash, Script] =
      (ws.nativeScripts.toMap.toSeq ++ ws.plutusV1Scripts.toMap.toSeq ++ ws.plutusV2Scripts.toMap.toSeq ++ ws.plutusV3Scripts.toMap.toSeq).toMap
    val witnessDatums: Map[DataHash, Data] = ws.plutusData.value.toMap.map { case (h, d) => h -> d.value }
    def plutus(h: ScriptHash): ScriptSource[PlutusScript] = scripts.get(h) match
      case Some(p: PlutusScript) => ScriptSource.PlutusScriptValue(p)
      case _ => ScriptSource.PlutusScriptAttached
    def native(h: ScriptHash): NativeScriptWitness = scripts.get(h) match
      case Some(n: Script.Native) => NativeScriptWitness(ScriptSource.NativeScriptValue(n))
      case _ => NativeScriptWitness(ScriptSource.NativeScriptAttached)
    val reds = f.redeemers.map { r =>
      val data = Data.fromCbor(r.data)
      val u = ExUnits(r.mem, r.steps)
      val target: Target = r.tag match
        case 0 => ("spend", Cbor.decode(txInputBytes(r.ref)).to[TransactionInput].value)
        case 1 => ("mint", Cbor.decode(bytesItem(r.policy)).to[ScriptHash].value)
        case 2 => ("cert", r.index)
        case 3 => ("reward", Cbor.decode(bytesItem(r.account)).to[RewardAccount].value)
        case 4 => ("vote", Cbor.decode(Main.unhex(r.voter)).to[Voter].value)
        case 5 => ("propose", r.index)
        case t => throw new IllegalArgumentException(s"redeemer tag $t")
      units(target) = u
      target -> data
    }.toMap
    def twoArg(t: Target, h: Option[ScriptHash]): Option[TwoArgumentPlutusScriptWitness] =
      reds.get(t).map(d => TwoArgumentPlutusScriptWitness(h.map(plutus).getOrElse(ScriptSource.PlutusScriptAttached), d))
    // A part with a script credential: the Plutus witness with its redeemer,
    // else the native script's.
    def scriptWitness(t: Target, h: Option[ScriptHash]): PubKeyWitness.type | NativeScriptWitness | TwoArgumentPlutusScriptWitness =
      twoArg(t, h).getOrElse(h match
        case Some(sh) => native(sh)
        case None => PubKeyWitness)
    // The builder resolves an attached script from the steps before it
    // (TransactionStepsProcessor.scala:1153): reference inputs first, then
    // the inputs spent without a redeemer, then the script inputs.
    val steps = Vector.newBuilder[Step]
    var usedDatums = Set[DataHash]()
    for x <- f.referenceInputs do steps += Step.ReferenceOutput(decodeUtxo(x.cbor))
    val fixedUtxos = f.inputs.map(x => decodeUtxo(x.cbor))
    def scriptOf(u: Utxo): Option[ScriptHash] = u.output.address match
      case a: scalus.cardano.address.ShelleyAddress => a.scriptHashOption
      case _ => None
    for u <- fixedUtxos if !reds.contains(("spend", u.input)) do
      steps += Step.Spend(u, scriptOf(u).map(native).getOrElse(PubKeyWitness))
    for u <- fixedUtxos; d <- reds.get(("spend", u.input)) do
      val datum = u.output.datumOption match
        case Some(DatumOption.Inline(_)) => scalus.cardano.txbuilder.Datum.DatumInlined
        case Some(DatumOption.Hash(h)) =>
          usedDatums += h
          scalus.cardano.txbuilder.Datum.DatumValue(witnessDatums.getOrElse(h, throw new IllegalStateException(s"no datum for $h")))
        case None =>
          throw NotReplayable("script input without a datum", s"a script input with no datum (${Main.hex(u.input.transactionId.bytes)}#${u.input.index}): the builder spends a script output only with its datum (TransactionStepsProcessor.scala:285-288)")
      steps += Step.Spend(u, ThreeArgumentPlutusScriptWitness(scriptOf(u).map(plutus).getOrElse(ScriptSource.PlutusScriptAttached), d, datum))
    body.ttl.foreach(s => steps += Step.ValidityEndSlot(s))
    body.validityStartSlot.foreach(s => steps += Step.ValidityStartSlot(s))
    body.requiredSigners.toSeq.foreach(h => steps += Step.RequireSignature(h))
    body.mint.foreach { m =>
      for (policy, assets) <- m.assets; (name, qty) <- assets do
        val w: NativeScriptWitness | TwoArgumentPlutusScriptWitness = twoArg(("mint", policy), Some(policy)).getOrElse(native(policy))
        steps += Step.Mint(policy, name, qty, w)
    }
    body.certificates.toSeq.zipWithIndex.foreach { case (c, i) =>
      steps += Step.IssueCertificate(c, scriptWitness(("cert", i), c.scriptHashOption))
    }
    body.withdrawals.foreach { w =>
      for (acct, coin) <- w.withdrawals do
        val cred = acct.scriptHashOption match
          case Some(h) => Credential.ScriptHash(h)
          case None => Credential.KeyHash(acct.keyHashOption.get.asInstanceOf[AddrKeyHash])
        steps += Step.WithdrawRewards(cred, coin, scriptWitness(("reward", acct), acct.scriptHashOption))
    }
    body.votingProcedures.foreach { v =>
      for (voter, votes) <- v.procedures do
        steps += Step.SubmitVotingProcedure(voter, votes, scriptWitness(("vote", voter), voter.scriptHashOption))
    }
    body.proposalProcedures.toSeq.zipWithIndex.foreach { case (p, i) =>
      val h = p.govAction match
        case GovAction.ParameterChange(_, _, ph) => ph
        case GovAction.TreasuryWithdrawals(_, ph) => ph
        case _ => None
      steps += Step.SubmitProposal(p, twoArg(("propose", i), h).getOrElse(PubKeyWitness))
    }
    body.currentTreasuryValue.foreach(v => steps += Step.SetCurrentTreasuryValue(v))
    body.donation.foreach(v => steps += Step.Donate(v))
    val aux = f.auxiliaryData.map(b => Cbor.decode(b).to[AuxiliaryData].value)
    (steps.result(), witnessDatums.filter((h, _) => !usedDatums.contains(h)).values.toSeq, aux)

  /** A reference "txid#index" as the CBOR of a TransactionInput. */
  private def txInputBytes(ref: String): Array[Byte] =
    val i = ref.indexOf('#')
    val id = Main.unhex(ref.substring(0, i))
    Array(0x82.toByte) ++ CborBytes.head(2, id.length) ++ id ++ CborBytes.head(0, ref.substring(i + 1).toLong)
