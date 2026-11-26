// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// cardano-client-lib 0.7.3 (com.bloxbean.cardano:cardano-client-lib, the
// release tag v0.7.3, commit f113017), its QuickTx builder at its defaults,
// called as a dapp calls it to build a payment for a wallet to sign (paths in
// bloxbean/cardano-client-lib at f113017):
//
//   new QuickTxBuilder(utxoSupplier, protocolParamsSupplier, processor)
//     .compose(new Tx().payToAddress(...) or .payToContract(...) for each
//                requested output .from(changeAddress)
//              [, a ScriptTx holding the replay's fixed inputs and script parts])
//     [.feePayer(changeAddress) when a ScriptTx is composed]
//     ...validity, required signers, the collateral set aside...
//     .build()
//
// (quicktx/.../QuickTxBuilder.java:80, :140, :299). build() writes no
// witness; the fee prices one vkey witness per distinct key of the inputs and
// collateral (function/.../helper/BalanceTxBuilders.java:113-124,
// UtxoUtil.getNoOfRequiredSigners). No signer is added (withSigner would
// price one more) and no option is set.
//
// The UtxoSupplier answers the wallet's address, the sender, with the wallet's
// spendable UTxOs 100 a page in the state's order and any other address with
// none; getTxOutput resolves every UTxO of the request. The default strategy,
// DefaultUtxoSelectionStrategyImpl (function/.../TxBuilderContext.java:69),
// reads those pages for each requested unit: within a page the UTxOs that hold
// the unit, in the page's order, taken whole until it is covered, with
// LargestFirstUtxoSelectionStrategy over the whole set when more than 20
// inputs would be needed (coinselection/.../DefaultUtxoSelectionStrategyImpl.
// java:41-148, :164-167). The fee is not in that target: the change output
// takes all that is left, and ChangeOutputAdjustments adds an ADA-only UTxO
// over the shortfall plus 2 ADA when the fee leaves the change under its
// minimum (ChangeOutputAdjustments.java:139-245). Requested outputs are
// rebuilt by OutputBuilders.createFromOutput, which merges outputs to one
// address and raises an output under its minimum (OutputBuilders.java:98-140).
//
// The replay's fixed parts go through QuickTx's operations: on the payment
// Tx, the metadata (attachMetadata), native mints (mintAssets), key-credential
// certificates (registerStakeAddress, deregisterStakeAddress, delegateTo,
// delegateVotingPowerTo, registerDRep, unregisterDRep, updateDRep,
// registerPool, retirePool), key withdrawals (withdraw), key votes
// (createVote), proposals with no redeemer (createProposal) and the donation
// (donateToTreasury); on a ScriptTx, fixed inputs (collectFrom, with the
// redeemer and datum for a script input), reference inputs (readFrom), Plutus
// mints (mintAsset), and the script-credential certificates, withdrawals,
// votes and proposals with their redeemers, and the Plutus scripts by
// attach...Validator; native scripts by attachNativeScript; the validity
// (validFrom, validTo), required signers (withRequiredSigners) and the
// collateral set aside (withCollateralInputs) on the context. QuickTx adds a
// Tx's collected UTxOs only when the Tx has an output (quicktx/.../
// AbstractTx.java:338-358), so a ScriptTx that collects fixed inputs is given
// one output to the wallet's address with no value: ccl raises it to its
// minimum and collects the inputs' value into it as that Tx's change
// (InputBuilders.java:282-338). The witness set's datums that no spent input
// takes are written by preBalanceTx, the context's hook for content before
// balancing, so the fee prices them.
package unfrackit.helper

import co.nstant.in.cbor.model.{Array as CArray, ByteString as CBytes, DataItem, Map as CMap, Special, UnsignedInteger}
import com.bloxbean.cardano.client.address.{Address, AddressProvider, Credential}
import com.bloxbean.cardano.client.api.{TransactionProcessor, UtxoSupplier}
import com.bloxbean.cardano.client.api.common.OrderEnum
import com.bloxbean.cardano.client.api.model.{Amount, EvaluationResult, ProtocolParams, Result, Utxo}
import com.bloxbean.cardano.client.common.cbor.CborSerializationUtil
import com.bloxbean.cardano.client.common.model.{Network, Networks}
import com.bloxbean.cardano.client.crypto.Blake2bUtil
import com.bloxbean.cardano.client.metadata.cbor.CBORMetadata
import com.bloxbean.cardano.client.plutus.spec.{ExUnits, PlutusData, PlutusScript, RedeemerTag}
import com.bloxbean.cardano.client.quicktx.{AbstractTx, QuickTxBuilder, ScriptTx, Tx}
import com.bloxbean.cardano.client.transaction.spec.{Asset, AuxiliaryData, Transaction, TransactionBody, TransactionInput, TransactionOutput, TransactionWitnessSet, VkeyWitness}
import com.bloxbean.cardano.client.transaction.spec.cert.*
import com.bloxbean.cardano.client.transaction.spec.script.NativeScript

import java.math.{BigDecimal, BigInteger}
import java.util.Optional
import scala.jdk.CollectionConverters.*

object Ccl:

  private def item(b: Array[Byte]): DataItem = CborSerializationUtil.deserialize(b)

  /** A TransactionUnspentOutput as ccl's provider model. */
  def utxoOf(ref: String, b: Array[Byte]): Utxo =
    val (_, o) = CborBytes.pair(b)
    val out = TransactionOutput.deserialize(item(o))
    val i = ref.indexOf('#')
    val amounts = new java.util.ArrayList[Amount]()
    amounts.add(Amount.lovelace(out.getValue.getCoin))
    for ma <- Option(out.getValue.getMultiAssets).map(_.asScala).getOrElse(Nil); a <- ma.getAssets.asScala do
      amounts.add(new Amount(ma.getPolicyId + Main.hex(a.getNameAsBytes), a.getValue))
    val u = new Utxo()
    u.setTxHash(ref.substring(0, i))
    u.setOutputIndex(ref.substring(i + 1).toInt)
    u.setAddress(out.getAddress)
    u.setAmount(amounts)
    if out.getDatumHash != null then u.setDataHash(Main.hex(out.getDatumHash))
    if out.getInlineDatum != null then u.setInlineDatum(out.getInlineDatum.serializeToHex)
    if out.getScriptRef != null then u.setReferenceScriptHash(Main.hex(scriptRefHash(out.getScriptRef)))
    u

  /** The hash of a script reference's script ([type, bytes]). */
  private def scriptRefHash(ref: Array[Byte]): Array[Byte] =
    try
      val p = PlutusScript.deserializeScriptRef(ref)
      if p != null then p.getScriptHash else NativeScript.deserializeScriptRef(ref).getScriptHash
    catch case _: Exception => NativeScript.deserializeScriptRef(ref).getScriptHash

  /** The wallet's spendable UTxOs for its address, 100 a page in the state's
    * order; every UTxO of the request by reference. */
  final class Supplier(address: String, wallet: Seq[Utxo], byRef: Map[String, Utxo]) extends UtxoSupplier:
    def getPage(addr: String, n: Integer, page: Integer, order: OrderEnum): java.util.List[Utxo] =
      if addr != address then java.util.List.of()
      else
        val from = page.intValue * n.intValue
        new java.util.ArrayList(wallet.slice(from, from + n.intValue).asJava)
    def getTxOutput(txHash: String, index: Int): Optional[Utxo] = Optional.ofNullable(byRef.getOrElse(s"$txHash#$index", null))

  /** The run's protocol parameters as ccl's. */
  def protocolParams(q: Request): ProtocolParams =
    val p = new ProtocolParams()
    def dec(k: String): Option[BigDecimal] = q.rational(k).map((n, d) => new BigDecimal(n.bigInteger).divide(new BigDecimal(d.bigInteger), java.math.MathContext.DECIMAL128))
    p.setMinFeeA(q.param("minFeeA").toInt)
    p.setMinFeeB(q.param("minFeeB").toInt)
    p.setMaxTxSize(q.param("maxTxSize").toInt)
    p.setMaxValSize(q.param("maxValSize").toString)
    p.setCoinsPerUtxoSize(q.param("coinsPerUtxoByte").toString)
    q.paramOpt("collateralPercent").foreach(v => p.setCollateralPercent(BigDecimal.valueOf(v)))
    q.paramOpt("maxCollateralInputs").foreach(v => p.setMaxCollateralInputs(v.toInt))
    dec("priceMem").foreach(p.setPriceMem)
    dec("priceStep").foreach(p.setPriceStep)
    dec("minFeeRefScriptCostPerByte").foreach(p.setMinFeeRefScriptCostPerByte)
    q.paramOpt("keyDeposit").foreach(v => p.setKeyDeposit(v.toString))
    q.paramOpt("poolDeposit").foreach(v => p.setPoolDeposit(v.toString))
    q.paramOpt("drepDeposit").foreach(v => p.setDrepDeposit(BigInteger.valueOf(v)))
    q.paramOpt("govActionDeposit").foreach(v => p.setGovActionDeposit(BigInteger.valueOf(v)))
    q.paramOpt("protocolMajor").foreach(v => p.setProtocolMajorVer(v.toInt))
    // The run states no cost models. ccl falls back to its own for Plutus V1
    // and V2 and has none for V3 (ScriptDataHashCalculator.java:47-67); the
    // V3 model a backend would supply is taken from the network's parameters
    // Scalus 1.5.0 bundles. Only the script-data hash depends on it.
    val bundled = (if q.networkId == 1 then scalus.cardano.ledger.CardanoInfo.mainnet else scalus.cardano.ledger.CardanoInfo.preprod).protocolParams.costModels.models
    val raw = new java.util.LinkedHashMap[String, java.util.List[java.lang.Long]]()
    bundled.get(2).foreach(v3 => raw.put("PlutusV3", new java.util.ArrayList(v3.map(java.lang.Long.valueOf).asJava)))
    p.setCostModelsRaw(raw)
    p

  /** The evaluator: the intent's observed units for each redeemer of the draft,
    * found by the part its index names in the ledger's order of the draft. It
    * submits nothing. */
  final class Observed(units: Map[String, (Long, Long)]) extends TransactionProcessor:
    def submitTransaction(cbor: Array[Byte]): Result[String] =
      throw new UnsupportedOperationException("the simulator submits nothing")
    def evaluateTx(cbor: Array[Byte], inputs: java.util.Set[Utxo]): Result[java.util.List[EvaluationResult]] =
      val tx = Transaction.deserialize(cbor)
      val body = tx.getBody
      val ins = body.getInputs.asScala.map(i => (i.getTransactionId, i.getIndex)).sortBy(identity).map((h, i) => s"$h#$i")
      val policies = Option(body.getMint).map(_.asScala.map(_.getPolicyId).sorted).getOrElse(Nil)
      val accounts = Option(body.getWithdrawals).map(_.asScala.map(w => Main.hex(new Address(w.getRewardAddress).getBytes)).sorted).getOrElse(Nil)
      val voters = Option(body.getVotingProcedures).map(_.getVoting.keySet.asScala.toSeq.map(v => Main.hex(CborSerializationUtil.serialize(v.serialize)))).getOrElse(Nil)
      val out = new java.util.ArrayList[EvaluationResult]()
      for r <- Option(tx.getWitnessSet.getRedeemers).map(_.asScala).getOrElse(Nil) do
        val i = r.getIndex.intValue
        val key = r.getTag match
          case RedeemerTag.Spend => ins.lift(i).map("0:" + _)
          case RedeemerTag.Mint => policies.lift(i).map("1:" + _)
          case RedeemerTag.Cert => Some(s"2:$i")
          case RedeemerTag.Reward => accounts.lift(i).map("3:" + _)
          case RedeemerTag.Voting => voters.sorted.lift(i).map("4:" + _)
          case RedeemerTag.Proposing => Some(s"5:$i")
          case _ => None
        val (mem, steps) = key.flatMap(units.get).getOrElse(throw new IllegalStateException(s"the draft's redeemer ${r.getTag}:$i has no observed redeemer"))
        val e = new EvaluationResult()
        e.setRedeemerTag(r.getTag)
        e.setIndex(i)
        e.setExUnits(ExUnits.builder().mem(BigInteger.valueOf(mem)).steps(BigInteger.valueOf(steps)).build())
        out.add(e)
      Result.success("evaluated").asInstanceOf[Result[java.util.List[EvaluationResult]]].withValue(out).asInstanceOf[Result[java.util.List[EvaluationResult]]]

  /** The network of the change address. */
  private def network(q: Request): Network = if q.networkId == 1 then Networks.mainnet else Networks.testnet

  def build(q: Request): (Array[Byte], Built) =
    val change = q.changeAddress
    val net = network(q)
    val params = try protocolParams(q) catch case e: Exception => throw StageError("replay parts", e)
    val wallet = q.utxos.map(u => try utxoOf(u.ref, u.cbor) catch case e: Exception => throw StageError("replay parts", new IllegalArgumentException(s"${u.ref}: ${Main.text(e)}")))
    val f = q.fixed
    val fixedUtxos = f.map(_.inputs.map(x => x.ref -> utxoOf(x.ref, x.cbor))).getOrElse(Nil)
    val refUtxos = f.map(_.referenceInputs.map(x => x.ref -> utxoOf(x.ref, x.cbor))).getOrElse(Nil)
    val coll = q.collateral.map(c => c.ref -> utxoOf(c.ref, c.cbor)).toSeq
    val byRef = (wallet.map(u => s"${u.getTxHash}#${u.getOutputIndex}" -> u) ++ fixedUtxos ++ refUtxos ++ coll).toMap
    val units = f.map(_.redeemers.map { r =>
      val key = r.tag match
        case 0 => s"0:${r.ref}"
        case 1 => s"1:${r.policy}"
        case 2 => s"2:${r.index}"
        case 3 => s"3:${r.account}"
        case 4 => s"4:${r.voter}"
        case 5 => s"5:${r.index}"
        case t => throw StageError("replay parts", new IllegalArgumentException(s"redeemer tag $t"))
      key -> (r.mem, r.steps)
    }.toMap).getOrElse(Map.empty)
    val processor = Observed(units)
    // The scripts the request's UTxOs carry as references, by hash, for the
    // builder's reference-script lookups (a backend's ScriptSupplier).
    val refScripts: Map[String, PlutusScript] = (f.map(x => x.inputs ++ x.referenceInputs).getOrElse(Nil) ++ q.utxos).flatMap { x =>
      scala.util.Try(Option(TransactionOutput.deserialize(item(CborBytes.pair(x.cbor)._2)).getScriptRef)).toOption.flatten
        .flatMap(r => scala.util.Try(Option(PlutusScript.deserializeScriptRef(r))).toOption.flatten)
        .map(s => Main.hex(s.getScriptHash) -> s)
    }.toMap
    val scripts: com.bloxbean.cardano.client.api.ScriptSupplier = (h: String) => Optional.ofNullable(refScripts.getOrElse(h, null))
    val builder = new QuickTxBuilder(Supplier(change, wallet, byRef), () => params, scripts, processor)
    val pay = new Tx()
    pay.from(change)
    val parts =
      try f.map(fx => Fixed_(fx, q, pay, change, net, fixedUtxos.toMap, refUtxos.toMap)).getOrElse(Fixed_.none)
      catch
        case e: NotReplayable => throw e
        case e: Exception => throw StageError("replay parts", e)
    // The requested outputs go on the Tx that selects from the wallet: the
    // payment Tx, or the ScriptTx of the parts a script redeems (a Plutus
    // mint among them, whose selection must count the mint, InputBuilders.
    // java:292-303). That Tx is composed last, after the Tx of the fixed
    // inputs.
    val target: AbstractTx[?] = if parts.outputsOnScript then parts.script.get else pay
    q.outputs.zipWithIndex.foreach { case (o, i) =>
      try requested(target, TransactionOutput.deserialize(item(o)))
      catch
        case e: NotReplayable => throw e
        case e: Exception => throw StageError("requested output", new IllegalArgumentException(s"output $i: ${Main.text(e)}"))
    }
    val txs: Seq[AbstractTx[?]] =
      parts.fixed.toSeq ++ (if parts.outputsOnScript then Seq(pay) ++ parts.script.toSeq else parts.script.toSeq ++ Seq(pay))
    var ctx = builder.compose(txs*)
    if txs.size > 1 then ctx = ctx.feePayer(change)
    if parts.others > 0 then ctx = ctx.additionalSignersCount(parts.others)
    parts.validFrom.foreach(s => ctx = ctx.validFrom(s))
    parts.validTo.foreach(s => ctx = ctx.validTo(s))
    if parts.signers.nonEmpty then ctx = ctx.withRequiredSigners(parts.signers*)
    if coll.nonEmpty then ctx = ctx.withCollateralInputs(coll.map((_, u) => new TransactionInput(u.getTxHash, u.getOutputIndex))*)
    if parts.datums.nonEmpty then
      ctx = ctx.preBalanceTx((_, txn) => {
        val list = txn.getWitnessSet.getPlutusDataList
        for d <- parts.datums if !list.contains(d) do list.add(d)
      })
    val tx =
      try ctx.build()
      catch case e: Exception => throw StageError("build", e)
    val owners = (tx.getBody.getInputs.asScala ++ Option(tx.getBody.getCollateral).map(_.asScala).getOrElse(Nil))
      .flatMap(i => byRef.get(s"${i.getTransactionId}#${i.getIndex}"))
      .flatMap(u => scala.util.Try(new Address(u.getAddress).getPaymentCredentialHash.orElse(null)).toOption.flatMap(Option(_)).map(Main.hex))
      .toSet
    val pricedCount = owners.size + parts.others
    val built = new Built:
      def priced: Int = pricedCount
      def withVkeys(vkeys: Seq[Array[Byte]]): Array[Byte] =
        val ws = vkeys.map { v =>
          val (k, s) = CborBytes.pair(v)
          new VkeyWitness(item(k).asInstanceOf[CBytes].getBytes, item(s).asInstanceOf[CBytes].getBytes)
        }
        if tx.getWitnessSet == null then tx.setWitnessSet(new TransactionWitnessSet())
        tx.getWitnessSet.setVkeyWitnesses(new java.util.ArrayList(ws.asJava))
        tx.serialize()
    (tx.serialize(), built)

  /** A requested output through the payment Tx's own operations, from its
    * decoded bytes. */
  private def requested(pay: AbstractTx[?], o: TransactionOutput): Unit =
    val amounts = new java.util.ArrayList[Amount]()
    amounts.add(Amount.lovelace(o.getValue.getCoin))
    for ma <- Option(o.getValue.getMultiAssets).map(_.asScala).getOrElse(Nil); a <- ma.getAssets.asScala do
      amounts.add(new Amount(ma.getPolicyId + Main.hex(a.getNameAsBytes), a.getValue))
    val ref = o.getScriptRef
    (Option(o.getInlineDatum), Option(o.getDatumHash)) match
      case (Some(d), _) => if ref != null then pay.payToContract(o.getAddress, amounts, d, ref) else pay.payToContract(o.getAddress, amounts, d)
      case (None, Some(h)) =>
        if ref != null then throw NotReplayable("output datum hash with a script reference", "a requested output with a datum hash and a script reference: no public QuickTx operation writes both (AbstractTx.java:115-195)")
        pay.payToContract(o.getAddress, amounts, Main.hex(h))
      case (None, None) => if ref != null then pay.payToAddress(o.getAddress, amounts, ref) else pay.payToAddress(o.getAddress, amounts)

  /** What the replay's fixed parts add: a ScriptTx when one is needed, the
    * context's validity and required signers, and the datums to write. */
  final case class Parts(fixed: Option[AbstractTx[?]], script: Option[ScriptTx], outputsOnScript: Boolean, validFrom: Option[Long], validTo: Option[Long], signers: Seq[Array[Byte]], others: Int, datums: Seq[PlutusData])

  object Fixed_ :
    val none = Parts(None, None, false, None, None, Nil, 0, Nil)

    def apply(f: Fixed, q: Request, pay: Tx, change: String, net: Network, fixedUtxos: Map[String, Utxo], refUtxos: Map[String, Utxo]): Parts =
      for k <- f.witnesses.keys do
        k match
          case 0 | 1 | 3 | 4 | 5 | 6 | 7 =>
          case 2 => throw NotReplayable("bootstrap witnesses", "a bootstrap witness: no QuickTx operation writes one")
          case _ => throw NotReplayable(s"witness set key $k", s"witness set key $k: no QuickTx operation writes it")
      for k <- f.body.keys do
        k match
          case 3 | 4 | 5 | 8 | 9 | 14 | 19 | 20 | 21 | 22 =>
          case _ => throw NotReplayable(s"body field $k", s"body field $k: no QuickTx operation writes it")
      // The fixed body fields and witness set, read with ccl's own decoders.
      val bodyMap = new CMap()
      bodyMap.put(new UnsignedInteger(0), new CArray())
      bodyMap.put(new UnsignedInteger(1), new CArray())
      bodyMap.put(new UnsignedInteger(2), new UnsignedInteger(0))
      for (k, v) <- f.body.toSeq.sortBy(_._1) do bodyMap.put(new UnsignedInteger(k), item(v))
      val body = TransactionBody.deserialize(bodyMap)
      val wsMap = new CMap()
      for (k, v) <- f.witnesses.toSeq.sortBy(_._1) if k != 0 do wsMap.put(new UnsignedInteger(k), item(v))
      val ws = Option(TransactionWitnessSet.deserialize(wsMap)).getOrElse(new TransactionWitnessSet())
      val plutus: Map[String, PlutusScript] =
        (Option(ws.getPlutusV1Scripts).map(_.asScala).getOrElse(Nil) ++ Option(ws.getPlutusV2Scripts).map(_.asScala).getOrElse(Nil) ++ Option(ws.getPlutusV3Scripts).map(_.asScala).getOrElse(Nil))
          .map(s => Main.hex(s.getScriptHash) -> (s: PlutusScript)).toMap
      val natives: Map[String, NativeScript] = Option(ws.getNativeScripts).map(_.asScala).getOrElse(Nil).map(s => Main.hex(s.getScriptHash) -> s).toMap
      // Scripts a reference input carries, which a ScriptTx operation is
      // given as the script itself.
      val refPlutus: Map[String, PlutusScript] = refUtxos.values.flatMap { u =>
        Option(u.getReferenceScriptHash).flatMap(_ => f.referenceInputs.find(x => x.ref == s"${u.getTxHash}#${u.getOutputIndex}"))
          .flatMap(x => Option(TransactionOutput.deserialize(item(CborBytes.pair(x.cbor)._2)).getScriptRef))
          .flatMap(r => scala.util.Try(PlutusScript.deserializeScriptRef(r)).toOption.flatMap(Option(_)))
          .map(s => Main.hex(s.getScriptHash) -> s)
      }.toMap
      def scriptFor(h: String): PlutusScript = plutus.getOrElse(h, refPlutus.getOrElse(h, throw new IllegalStateException(s"no Plutus script $h in the witness set or a reference input")))
      val datums: Map[String, PlutusData] = Option(ws.getPlutusDataList).map(_.asScala).getOrElse(Nil).map(d => d.getDatumHash -> d).toMap
      val reds = f.redeemers.map(r => r.tag -> r).groupMap(_._1)(_._2)
      def red(tag: Int, p: IntentRedeemer => Boolean): Option[PlutusData] = reds.getOrElse(tag, Nil).find(p).map(r => PlutusData.deserialize(r.data))
      // The fixed inputs and reference inputs go in a ScriptTx of their own
      // (a Tx can collect given UTxOs only without a sender, which QuickTx
      // refuses beside the payment's), the parts redeemed by a script (other
      // than spends) in another ScriptTx, everything else on the payment Tx.
      var fx: Option[ScriptTx] = None
      def fixedTx(): ScriptTx =
        if fx.isEmpty then fx = Some(new ScriptTx())
        fx.get
      var st: Option[ScriptTx] = None
      def script(): ScriptTx =
        if st.isEmpty then st = Some(new ScriptTx())
        st.get
      natives.values.foreach(pay.attachNativeScript)
      var usedDatums = Set[String]()
      var attached = Set[String]()
      def attach(kind: String, h: String): Unit =
        if !attached.contains(h) && plutus.contains(h) then
          val s = plutus(h)
          kind match
            case "spend" => fixedTx().attachSpendingValidator(s)
            case "cert" => script().attachCertificateValidator(s)
            case "reward" => script().attachRewardValidator(s)
            case "propose" => script().attachProposingValidator(s)
            case "vote" => script().attachVotingValidator(s)
          attached += h
      // Fixed inputs: spent with their redeemer and datum when redeemed.
      if f.inputs.nonEmpty then
        for x <- f.inputs do
          val u = fixedUtxos(x.ref)
          red(0, _.ref == x.ref) match
            case Some(d) =>
              val addr = new Address(u.getAddress)
              val h = addr.getPaymentCredentialHash.map(Main.hex).orElse(null)
              if u.getDataHash != null then
                usedDatums += u.getDataHash
                fixedTx().collectFrom(u, d, datums.getOrElse(u.getDataHash, throw new IllegalStateException(s"no datum ${u.getDataHash}")))
              else fixedTx().collectFrom(u, d)
              if h != null then attach("spend", h)
            case None => fixedTx().collectFrom(u)
        fixedTx().payToAddress(change, Amount.lovelace(BigInteger.ZERO))
      for x <- f.referenceInputs do
        val i = x.ref.indexOf('#')
        fixedTx().readFrom(x.ref.substring(0, i), x.ref.substring(i + 1).toInt)
      // The mint: a Plutus policy's by mintAsset with its redeemer, a native
      // policy's by mintAssets.
      val mints = Option(body.getMint).map(_.asScala.toSeq).getOrElse(Nil)
      val plutusMint = mints.exists(ma => red(1, _.policy == ma.getPolicyId).isDefined)
      if plutusMint && mints.exists(ma => red(1, _.policy == ma.getPolicyId).isEmpty) then
        throw NotReplayable("native and Plutus mint", "a native and a Plutus policy minting in one transaction: QuickTx mints a native policy on a Tx (mintAssets) and a Plutus policy on a ScriptTx (mintAsset), each counting the other's mint in its own selection (InputBuilders.java:292-303)")
      // A policy's minted tokens that no requested output carries go to the
      // wallet's address, the mint operation's receiver; without one, QuickTx
      // selects for the outputs less the mint and would look for a negative
      // quantity (InputBuilders.java:292-303).
      val requestedUnits: Set[String] = q.outputs.flatMap { o =>
        val v = TransactionOutput.deserialize(item(o)).getValue
        Option(v.getMultiAssets).map(_.asScala).getOrElse(Nil).flatMap(ma => ma.getAssets.asScala.map(a => ma.getPolicyId + Main.hex(a.getNameAsBytes)))
      }.toSet
      for ma <- mints do
        val assets = ma.getAssets.asScala.map(a => new Asset(a.getName, a.getValue)).toList.asJava
        val minted = ma.getAssets.asScala.filter(_.getValue.signum > 0).map(a => ma.getPolicyId + Main.hex(a.getNameAsBytes))
        val receiver = if minted.nonEmpty && !minted.exists(requestedUnits.contains) then change else null
        red(1, _.policy == ma.getPolicyId) match
          case Some(d) => script().mintAsset(scriptFor(ma.getPolicyId), assets, d, receiver)
          case None =>
            natives.get(ma.getPolicyId) match
              case Some(n) => pay.mintAssets(n, assets, receiver)
              case None => throw NotReplayable("mint by a reference native script", s"a mint under native policy ${ma.getPolicyId} with no script in the witness set: mintAssets takes the native script itself (Tx.java:61-123)")
      // Certificates, each through its operation.
      def stakeAddr(c: StakeCredential): Address =
        val cred = if c.getType == StakeCredType.SCRIPTHASH then Credential.fromScript(c.getHash) else Credential.fromKey(c.getHash)
        AddressProvider.getRewardAddress(cred, net)
      def isScript(c: StakeCredential) = c.getType == StakeCredType.SCRIPTHASH
      for (c, i) <- Option(body.getCerts).map(_.asScala.zipWithIndex).getOrElse(Nil) do
        val r = red(2, _.index == i)
        c match
          case x: StakeRegistration => pay.registerStakeAddress(stakeAddr(x.getStakeCredential))
          case x: RegCert => pay.registerStakeAddress(stakeAddr(x.getStakeCredential))
          case x: StakeDeregistration =>
            r match
              case Some(d) => attach("cert", Main.hex(x.getStakeCredential.getHash)); script().deregisterStakeAddress(stakeAddr(x.getStakeCredential), d)
              case None => pay.deregisterStakeAddress(stakeAddr(x.getStakeCredential))
          case x: UnregCert =>
            r match
              case Some(d) => attach("cert", Main.hex(x.getStakeCredential.getHash)); script().deregisterStakeAddress(stakeAddr(x.getStakeCredential), d)
              case None => pay.deregisterStakeAddress(stakeAddr(x.getStakeCredential))
          case x: StakeDelegation =>
            val pool = Main.hex(x.getStakePoolId.getPoolKeyHash)
            r match
              case Some(d) => attach("cert", Main.hex(x.getStakeCredential.getHash)); script().delegateTo(stakeAddr(x.getStakeCredential), pool, d)
              case None => pay.delegateTo(stakeAddr(x.getStakeCredential), pool)
          case x: VoteDelegCert =>
            r match
              case Some(d) => attach("cert", Main.hex(x.getStakeCredential.getHash)); script().delegateVotingPowerTo(stakeAddr(x.getStakeCredential), x.getDrep, d)
              case None => pay.delegateVotingPowerTo(stakeAddr(x.getStakeCredential), x.getDrep)
          case x: RegDRepCert =>
            r match
              case Some(d) => attach("cert", Main.hex(x.getDrepCredential.getBytes)); script().registerDRep(x.getDrepCredential, x.getAnchor, d)
              case None => pay.registerDRep(x.getDrepCredential, x.getAnchor)
          case x: UnregDRepCert =>
            r match
              case Some(d) => attach("cert", Main.hex(x.getDrepCredential.getBytes)); script().unRegisterDRep(x.getDrepCredential, change, x.getCoin, d)
              case None => pay.unregisterDRep(x.getDrepCredential, change, x.getCoin)
          case x: UpdateDRepCert =>
            r match
              case Some(d) => attach("cert", Main.hex(x.getDrepCredential.getBytes)); script().updateDRep(x.getDrepCredential, x.getAnchor, d)
              case None => pay.updateDRep(x.getDrepCredential, x.getAnchor)
          case x: PoolRegistration if r.isEmpty => pay.registerPool(x)
          case x: PoolRetirement if r.isEmpty => pay.retirePool(StakePoolId(x.getPoolKeyHash).getBech32PoolId, x.getEpoch.toInt)
          case other => throw NotReplayable(s"certificate ${other.getClass.getSimpleName}", s"a ${other.getClass.getSimpleName} certificate${if r.isDefined then " with a redeemer" else ""}: no QuickTx operation writes it")
      // Withdrawals, to the change address.
      for w <- Option(body.getWithdrawals).map(_.asScala).getOrElse(Nil) do
        val acct = new Address(w.getRewardAddress)
        red(3, _.account == Main.hex(acct.getBytes)) match
          case Some(d) =>
            acct.getDelegationCredentialHash.ifPresent(h => attach("reward", Main.hex(h)))
            script().withdraw(w.getRewardAddress, w.getCoin, d)
          case None => pay.withdraw(w.getRewardAddress, w.getCoin)
      // Votes and proposals.
      for vp <- Option(body.getVotingProcedures).toSeq; (voter, votes) <- vp.getVoting.asScala; (id, proc) <- votes.asScala do
        val vh = Main.hex(CborSerializationUtil.serialize(voter.serialize))
        red(4, _.voter == vh) match
          case Some(d) => attach("vote", Main.hex(voter.getCredential.getBytes)); script().createVote(voter, id, proc.getVote, proc.getAnchor, d)
          case None => pay.createVote(voter, id, proc.getVote, proc.getAnchor)
      for (p, i) <- Option(body.getProposalProcedures).map(_.asScala.zipWithIndex).getOrElse(Nil) do
        red(5, _.index == i) match
          case Some(d) =>
            for h <- plutus.keys do attach("propose", h)
            script().createProposal(p.getGovAction, p.getRewardAccount, p.getAnchor, d)
          case None => pay.createProposal(p.getGovAction, p.getRewardAccount, p.getAnchor)
      (Option(body.getCurrentTreasuryValue), Option(body.getDonation)) match
        case (Some(t), Some(d)) => pay.donateToTreasury(t, d)
        case (None, None) =>
        case _ => throw NotReplayable("treasury value without a donation", "a current treasury value without a donation, or the reverse: donateToTreasury writes both (AbstractTx.java:255-262)")
      // The auxiliary data: its metadata through attachMetadata.
      for aux <- f.auxiliaryData do
        metadataOf(aux) match
          case Left(why) => throw NotReplayable("auxiliary scripts", why)
          case Right(Some(m)) => pay.attachMetadata(m)
          case Right(None) =>
      // Plutus scripts no part above attached (a script whose role the
      // intent does not name), as spending validators.
      for h <- plutus.keys if !attached.contains(h) && !reds.getOrElse(1, Nil).exists(_.policy == h) do attach("spend", h)
      val validFrom = Option(body.getValidityStartInterval).filter(_ > 0)
      val validTo = Option(body.getTtl).filter(_ > 0)
      val signers = Option(body.getRequiredSigners).map(_.asScala.toSeq).getOrElse(Nil)
      // The vkey witnesses beyond the inputs' and the collateral's keys: the
      // intent's other observed witnesses and the required signers none of
      // them signs, which a caller signing outside ccl declares through
      // additionalSignersCount (QuickTxBuilder.java:289-296).
      val observed = f.witnesses.get(0).map(CborBytes.items).getOrElse(Nil)
      val signedBy = observed.map(w => Main.hex(Blake2bUtil.blake2bHash224(item(CborBytes.pair(w)._1).asInstanceOf[CBytes].getBytes))).toSet
      val others = observed.size + signers.count(h => !signedBy.contains(Main.hex(h)))
      // The requested outputs go on the ScriptTx when there is one, so that
      // one Tx selects from the wallet: QuickTx does not exclude a UTxO one Tx
      // selected from another Tx's selection over the same sender, so two
      // selecting Txs spend one UTxO twice.
      Parts(fx, st, st.isDefined, validFrom, validTo, signers, others, datums.filter((h, _) => !usedDatums.contains(h)).values.toSeq)

  /** The metadata of auxiliary data, or why it cannot be written. */
  private def metadataOf(b: Array[Byte]): Either[String, Option[CBORMetadata]] =
    item(b) match
      case m: CMap if m.getTag == null => Right(Some(CBORMetadata.deserialize(m)))
      case m: CMap =>
        val aux = AuxiliaryData.deserialize(m)
        val scripts = Seq(aux.getNativeScripts, aux.getPlutusV1Scripts, aux.getPlutusV2Scripts, aux.getPlutusV3Scripts).exists(l => l != null && !l.isEmpty)
        if scripts then Left("auxiliary data holding scripts: attachMetadata writes metadata only (AbstractTx.java:287-293)")
        else Right(Option(m.get(new UnsignedInteger(0))).collect { case mm: CMap => CBORMetadata.deserialize(mm) })
      case a: CArray =>
        val items = a.getDataItems.asScala
        val scripts = items.lift(1).exists { case s: CArray => !s.getDataItems.isEmpty; case _ => false }
        if scripts then Left("auxiliary data holding scripts: attachMetadata writes metadata only (AbstractTx.java:287-293)")
        else Right(items.headOption.collect { case mm: CMap => CBORMetadata.deserialize(mm) })
      case _ => Right(None)
