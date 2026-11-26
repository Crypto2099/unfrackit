// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// The JVM helper of the simulator's bridge (src/methods/helper.mjs, schema 1):
// one process per worker serves the JVM libraries, the request naming the
// library: cardano-client-lib 0.7.3 (library "ccl", Ccl.scala) and Scalus
// 1.5.0 (library "scalus", ScalusLib.scala). It reads one request per line on stdin and
// writes one response per line on stdout, and exits at the end of its input.
// The libraries' own logging is sent to stderr, so stdout carries responses
// only.
package unfrackit.helper

import com.fasterxml.jackson.databind.{JsonNode, ObjectMapper}
import com.fasterxml.jackson.databind.node.ObjectNode

import java.io.{BufferedReader, FileDescriptor, FileOutputStream, InputStreamReader, PrintStream}
import java.nio.charset.StandardCharsets.UTF_8
import scala.collection.mutable
import scala.jdk.CollectionConverters.*

/** A part the library has no way to express. */
final case class NotReplayable(part: String, why: String) extends Exception(why)

/** A failure with the place it happened (the response's stage). */
final case class StageError(stage: String, cause: Throwable) extends Exception(Main.text(cause), cause)

/** A transaction a library built, which a witness request fills. */
trait Built:
  /** The transaction with these vkey witnesses (each [vkey, signature] as
    * bytes) in place of any it holds, in the library's own encoding. */
  def withVkeys(vkeys: Seq[Array[Byte]]): Array[Byte]

  /** The number of vkey witnesses the library's fee priced. */
  def priced: Int

final case class FixedInput(ref: String, cbor: Array[Byte])

/** A redeemer of the intent, with the part it redeems as the history reader
  * records it (kit/replay.mjs targetKey). */
final case class IntentRedeemer(tag: Int, kind: String, ref: String, policy: String, index: Int, account: String, voter: String, data: Array[Byte], mem: Long, steps: Long)

final case class Fixed(
    inputs: Seq[FixedInput],
    referenceInputs: Seq[FixedInput],
    body: Map[Int, Array[Byte]],
    witnesses: Map[Int, Array[Byte]],
    redeemers: Seq[IntentRedeemer],
    auxiliaryData: Option[Array[Byte]]
)

/** A build request, decoded. */
final case class Request(
    library: String,
    networkId: Int,
    slot: Option[Long],
    changeAddress: String,
    utxos: Seq[FixedInput],
    outputs: Seq[Array[Byte]],
    params: JsonNode,
    seed: Option[String],
    fixed: Option[Fixed],
    collateral: Option[FixedInput]
):
  def param(k: String): Long =
    val v = params.path(k)
    if v.isMissingNode || v.isNull then throw new IllegalArgumentException(s"parameter $k missing")
    if v.isTextual then java.lang.Long.parseLong(v.asText) else v.asLong

  def paramOpt(k: String): Option[Long] =
    val v = params.path(k)
    if v.isMissingNode || v.isNull then None else Some(if v.isTextual then java.lang.Long.parseLong(v.asText) else v.asLong)

  /** A rational parameter as (numerator, denominator). */
  def rational(k: String): Option[(BigInt, BigInt)] =
    val v = params.path(k)
    if !v.isArray || v.size != 2 then None
    else Some((BigInt(v.get(0).asText), BigInt(v.get(1).asText)))

object Main:
  val Schema = 1
  val mapper = new ObjectMapper()

  /** The bytes of every reference this process has been sent. */
  val cache = mutable.HashMap[String, Array[Byte]]()

  var last: Option[Built] = None

  def text(e: Throwable): String =
    val m = e.getMessage
    val t = e.getClass.getSimpleName
    if m == null then t else s"$t: $m"

  def hex(b: Array[Byte]): String = b.map(x => f"${x & 0xff}%02x").mkString

  def unhex(s: String): Array[Byte] =
    val out = new Array[Byte](s.length / 2)
    var i = 0
    while i < out.length do
      out(i) = Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16).toByte
      i += 1
    out

  def main(args: Array[String]): Unit =
    val out = new PrintStream(new FileOutputStream(FileDescriptor.out), false, UTF_8)
    System.setOut(System.err)
    val in = new BufferedReader(new InputStreamReader(System.in, UTF_8), 1 << 20)
    var line = in.readLine()
    while line != null do
      if line.nonEmpty then
        val q =
          try mapper.readTree(line)
          catch
            case e: Exception =>
              System.err.println(s"jvm helper: a request that is not JSON: ${e.getMessage}")
              sys.exit(2)
        val r = answer(q)
        r.put("id", q.path("id").asLong)
        out.print(mapper.writeValueAsString(r))
        out.print('\n')
        out.flush()
      line = in.readLine()

  def failure(error: String): ObjectNode =
    val r = mapper.createObjectNode()
    r.put("ok", false)
    r.put("error", error)
    r

  def answer(q: JsonNode): ObjectNode =
    if q.path("schema").asInt != Schema then return failure(s"schema ${q.path("schema").asInt}, the helper's $Schema")
    q.path("op").asText match
      case "build" =>
        last = None
        try
          val req = request(q)
          val (tx, built) = req.library match
            case "ccl" => Ccl.build(req)
            case "scalus" => ScalusLib.build(req)
            case other => throw new IllegalArgumentException(s"unknown library $other")
          last = Some(built)
          val r = mapper.createObjectNode()
          r.put("ok", true)
          r.put("tx", hex(tx))
          r
        catch
          case NotReplayable(part, why) =>
            val r = failure(why)
            r.put("notReplayable", part)
            r
          case StageError(stage, cause) =>
            val r = failure(text(cause))
            r.put("stage", stage)
            r
          case e: Exception =>
            val r = failure(text(e))
            r.put("stage", "replay parts")
            r
      case "witness" =>
        last match
          case None => failure("no transaction built")
          case Some(b) =>
            val vkeys = q.path("vkeys").asScala.map(n => unhex(n.asText)).toSeq
            try
              val tx = b.withVkeys(vkeys)
              val r = mapper.createObjectNode()
              r.put("ok", true)
              r.put("tx", hex(tx))
              // The observed vkey witnesses outnumber the keys the fee priced.
              if q.path("observed").asInt > 0 && vkeys.size > b.priced then r.putArray("unpriced").add("observed vkey witnesses")
              r
            catch case e: Exception => failure(text(e))
      case op => failure(s"unknown op $op")

  private def str(n: JsonNode): String = if n.isMissingNode || n.isNull then null else n.asText

  def request(q: JsonNode): Request =
    val utxos = q.path("utxos").asScala.toSeq.map { u =>
      val ref = u.path("ref").asText
      val c = u.path("cbor")
      if !c.isMissingNode && !c.isNull then cache(ref) = unhex(c.asText)
      FixedInput(ref, cache.getOrElse(ref, throw StageError("replay parts", new IllegalStateException(s"no bytes for $ref"))))
    }
    val f = q.path("intent").path("fixed")
    val fixed =
      if f.isMissingNode || f.isNull then None
      else
        def inputs(n: JsonNode) = n.asScala.toSeq.map(x => FixedInput(x.path("ref").asText, unhex(x.path("cbor").asText)))
        def fields(n: JsonNode) = n.properties.asScala.map(e => e.getKey.toInt -> unhex(e.getValue.asText)).toMap
        val redeemers = f.path("redeemers").asScala.toSeq.map { r =>
          val t = r.path("target")
          IntentRedeemer(
            r.path("tag").asInt, str(t.path("kind")), str(t.path("ref")), Option(str(t.path("policy"))).map(_.toLowerCase).orNull,
            t.path("index").asInt(-1), Option(str(t.path("account"))).map(_.toLowerCase).orNull, Option(str(t.path("voter"))).map(_.toLowerCase).orNull,
            unhex(r.path("data").asText), r.path("exUnits").get(0).asText.toLong, r.path("exUnits").get(1).asText.toLong
          )
        }
        val aux = f.path("auxiliaryData")
        Some(Fixed(inputs(f.path("inputs")), inputs(f.path("referenceInputs")), fields(f.path("body")), fields(f.path("witnesses")), redeemers,
          if aux.isMissingNode || aux.isNull then None else Some(unhex(aux.asText))))
    val c = q.path("collateral")
    val slot = q.path("at").path("slot")
    Request(
      library = q.path("library").asText,
      networkId = q.path("networkId").asInt,
      slot = if slot.isMissingNode || slot.isNull then None else Some(slot.asLong),
      changeAddress = q.path("changeAddress").asText,
      utxos = utxos,
      outputs = q.path("outputs").asScala.toSeq.map(n => unhex(n.asText)),
      params = q.path("params"),
      seed = Option(str(q.path("seed"))),
      fixed = fixed,
      collateral = if c.isMissingNode || c.isNull then None else Some(FixedInput(c.path("ref").asText, unhex(c.path("cbor").asText)))
    )

/** CBOR heads and the two halves of a TransactionUnspentOutput. */
object CborBytes:
  def head(major: Int, n: Long): Array[Byte] =
    val m = (major << 5).toByte
    if n < 24 then Array((m | n.toInt).toByte)
    else if n < 0x100 then Array((m | 24).toByte, n.toByte)
    else if n < 0x10000 then Array((m | 25).toByte, (n >> 8).toByte, n.toByte)
    else if n < 0x100000000L then Array((m | 26).toByte, (n >> 24).toByte, (n >> 16).toByte, (n >> 8).toByte, n.toByte)
    else Array((m | 27).toByte) ++ (0 until 8).reverse.map(i => (n >> (8 * i)).toByte)

  /** A map of unsigned keys to items given as their bytes. */
  def map(entries: Seq[(Int, Array[Byte])]): Array[Byte] =
    entries.foldLeft(head(5, entries.size)) { case (acc, (k, v)) => acc ++ head(0, k) ++ v }

  /** The length of the item at `off`, and of every item it holds. */
  def itemEnd(b: Array[Byte], off: Int): Int =
    val ib = b(off) & 0xff
    val major = ib >> 5
    val info = ib & 0x1f
    var p = off + 1
    def arg(): Long =
      info match
        case i if i < 24 => i.toLong
        case 24 => p += 1; (b(p - 1) & 0xff).toLong
        case 25 => p += 2; ((b(p - 2) & 0xff) << 8 | (b(p - 1) & 0xff)).toLong
        case 26 => p += 4; (0 until 4).foldLeft(0L)((a, i) => (a << 8) | (b(p - 4 + i) & 0xff))
        case 27 => p += 8; (0 until 8).foldLeft(0L)((a, i) => (a << 8) | (b(p - 8 + i) & 0xff))
        case _ => -1L
    major match
      case 0 | 1 | 7 => arg(); p
      case 2 | 3 =>
        if info == 31 then
          while (b(p) & 0xff) != 0xff do p = itemEnd(b, p)
          p + 1
        else
          val n = arg(); p + n.toInt
      case 4 | 5 =>
        if info == 31 then
          while (b(p) & 0xff) != 0xff do p = itemEnd(b, p)
          p + 1
        else
          val n = arg() * (if major == 5 then 2 else 1)
          var i = 0L
          while i < n do
            p = itemEnd(b, p)
            i += 1
          p
      case 6 => arg(); itemEnd(b, p)

  /** The input's and the output's bytes of a TransactionUnspentOutput. */
  def pair(b: Array[Byte]): (Array[Byte], Array[Byte]) =
    val first = 1
    val second = itemEnd(b, first)
    val end = itemEnd(b, second)
    (b.slice(first, second), b.slice(second, end))

  /** The items of a CBOR array or set (tag 258 skipped). */
  def items(b: Array[Byte]): Seq[Array[Byte]] =
    var p = 0
    if (b(0) & 0xff) == 0xd9 && (b(1) & 0xff) == 0x01 && (b(2) & 0xff) == 0x02 then p = 3
    val ib = b(p) & 0xff
    val info = ib & 0x1f
    val out = Seq.newBuilder[Array[Byte]]
    if info == 31 then
      p += 1
      while (b(p) & 0xff) != 0xff do
        val e = itemEnd(b, p)
        out += b.slice(p, e)
        p = e
    else
      val (n, start) = info match
        case i if i < 24 => (i.toLong, p + 1)
        case 24 => ((b(p + 1) & 0xff).toLong, p + 2)
        case 25 => (((b(p + 1) & 0xff) << 8 | (b(p + 2) & 0xff)).toLong, p + 3)
        case 26 => ((0 until 4).foldLeft(0L)((a, i) => (a << 8) | (b(p + 1 + i) & 0xff)), p + 5)
        case _ => throw new IllegalArgumentException("array too long")
      p = start
      var i = 0L
      while i < n do
        val e = itemEnd(b, p)
        out += b.slice(p, e)
        p = e
        i += 1
    out.result()
