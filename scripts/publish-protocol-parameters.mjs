#!/usr/bin/env node
// Fetch the current protocol parameters for each network from Koios and write
// <out>/<network>.json, which the app reads from its own origin.
//
//   node scripts/publish-protocol-parameters.mjs [--out DIR] [--upload s3://BUCKET]
//
// --out defaults to public/protocol-parameters, which the dev server serves.
// --upload copies each file written by this run to s3://BUCKET/protocol-parameters/.
// Exits non-zero when any network failed, after uploading the ones that succeeded.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORKS, normalize } from "../src/protocol-parameters.js";

const HOSTS = { mainnet: "api", preprod: "preprod", preview: "preview" };
const SELECT = [
  "epoch_no",
  "min_fee_a",
  "min_fee_b",
  "max_tx_size",
  "max_val_size",
  "coins_per_utxo_size",
  "key_deposit",
  "pool_deposit",
  "price_mem",
  "price_step",
  "protocol_major",
  "collateral_percent",
  "max_collateral_inputs",
].join(",");
const ATTEMPTS = 3;
const PAUSE_MS = 5000;

function parseArgs(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const args = { out: path.join(root, "public", "protocol-parameters"), upload: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out" && argv[i + 1]) {
      args.out = path.resolve(argv[++i]);
    } else if (argv[i] === "--upload" && argv[i + 1]) {
      args.upload = argv[++i].replace(/\/+$/, "");
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (args.upload !== null && !args.upload.startsWith("s3://")) {
    throw new Error(`--upload takes an s3:// URL, got ${args.upload}`);
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchRow(network) {
  const url = `https://${HOSTS[network]}.koios.rest/api/v1/epoch_params?select=${SELECT}&order=epoch_no.desc&limit=1`;
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }
      const rows = await response.json();
      const fetchedAt = Math.floor(Date.now() / 1000);
      if (!Array.isArray(rows) || rows.length !== 1) {
        throw new Error(`expected one row, got ${JSON.stringify(rows).slice(0, 200)}`);
      }
      const row = rows[0];
      normalize(row);
      return { row, fetchedAt };
    } catch (e) {
      lastError = e;
      console.error(`${network}: attempt ${attempt} of ${ATTEMPTS} failed: ${e.message}`);
      if (attempt < ATTEMPTS) {
        await sleep(PAUSE_MS);
      }
    }
  }
  throw lastError;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });

  const written = [];
  const failed = [];
  for (const network of NETWORKS) {
    try {
      const { row, fetchedAt } = await fetchRow(network);
      const file = { network, epoch_no: row.epoch_no, fetched_at: fetchedAt, ...row };
      normalize(file);
      const target = path.join(args.out, `${network}.json`);
      writeFileSync(target, JSON.stringify(file) + "\n");
      written.push({ network, target });
      console.log(`${network}: epoch ${row.epoch_no} written to ${target}`);
    } catch (e) {
      failed.push(network);
      console.error(`${network}: not published: ${e.message}`);
    }
  }

  if (args.upload !== null) {
    for (const { network, target } of written) {
      try {
        execFileSync(
          "aws",
          [
            "s3",
            "cp",
            target,
            `${args.upload}/protocol-parameters/${network}.json`,
            "--content-type",
            "application/json",
            "--cache-control",
            "public, max-age=600",
            "--acl",
            "public-read",
          ],
          { stdio: "inherit" }
        );
      } catch (e) {
        failed.push(network);
        console.error(`${network}: upload failed: ${e.message}`);
      }
    }
  }

  if (failed.length) {
    console.error(`Failed: ${[...new Set(failed)].join(", ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
