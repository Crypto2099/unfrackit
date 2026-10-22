import {Buffer} from "buffer";
import * as CSL from "@emurgo/cardano-serialization-lib-asmjs";

// Wallet discovery checks every 200 ms for the first 2 s, then every second up to 10 s.
const DISCOVERY_FAST_MS = 2000;
const DISCOVERY_WINDOW_MS = 10000;

// The CIP-30 methods the app calls. The wallet's API object is reached only through
// these wrappers, so Vue never observes (and so never writes onto) the object itself.
const API_METHODS = [
    "getNetworkId",
    "getUtxos",
    "getUsedAddresses",
    "getUnusedAddresses",
    "getChangeAddress",
    "getRewardAddresses",
    "signTx",
    "submitTx",
];

function wrapApi(api) {
    const wrapped = {};
    for (const method of API_METHODS) {
        wrapped[method] = (...args) => api[method](...args);
    }
    return Object.freeze(wrapped);
}

// Lace registers "lace": capitalise an all-lowercase name; drop a trailing " Wallet".
function displayName(name) {
    let display = name.replace(/ Wallet$/, "");
    if (display === display.toLowerCase()) {
        display = display.charAt(0).toUpperCase() + display.slice(1);
    }
    return display;
}

// Every wallet registered under window.cardano with the CIP-30 initial API shape.
// No allowlist: any key whose value has enable(), isEnabled(), a name, an icon and an
// apiVersion is a wallet. VESPR's compatibility mirrors of other wallets are skipped.
// Registrations are frozen records of our own; the wallet's object is never written to.
export function discoverWallets(root) {
    if (root === null || typeof root !== "object") {
        return [];
    }
    let keys;
    try {
        keys = Object.keys(root);
    } catch (e) {
        return [];
    }
    const groups = new Map();
    for (const key of keys) {
        try {
            const value = root[key];
            if (value === null || typeof value !== "object") {
                continue;
            }
            if (typeof value.enable !== "function" || typeof value.isEnabled !== "function") {
                continue;
            }
            const name = value.name;
            const icon = value.icon;
            if (typeof name !== "string" || name === "" || typeof icon !== "string" || icon === "") {
                continue;
            }
            if (value.apiVersion === undefined) {
                continue;
            }
            const experimental = value.experimental;
            if (experimental && experimental.vespr_compat === true) {
                continue;
            }
            if (/via VESPR/i.test(name)) {
                continue;
            }
            const extensions = value.supportedExtensions;
            const registration = Object.freeze({
                key,
                name,
                displayName: displayName(name),
                icon,
                apiVersion: value.apiVersion,
                supportedExtensions: Array.isArray(extensions) ? extensions.slice() : [],
                handle: value,
            });
            // One wallet registered under two keys, or a mirror with the same name and
            // icon, is listed once; prefer the key that matches the name.
            const id = name.toLowerCase() + "\u0000" + icon;
            const existing = groups.get(id);
            if (!existing || (existing.key !== name.toLowerCase() && key === name.toLowerCase())) {
                groups.set(id, registration);
            }
        } catch (e) {
            // A getter that throws: skip this key.
        }
    }
    return [...groups.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function readWindowCardano() {
    try {
        return window.cardano;
    } catch (e) {
        return undefined;
    }
}

export default {
    install(Vue) {
        Vue.mixin({
            data() {
                return {
                    cardano: {
                        status: "init",
                        Wallets: [],
                        Wallet: null,
                        ActiveWallet: false,
                        change_address: null,
                        lovelace_format: {
                            minimumIntegerDigits: 1,
                            maximumFractionDigits: 6,
                            minimumFractionDigits: 0,
                        },
                    },
                };
            },
            methods: {
                formatAda(value) {
                    let the_number = Number(value);
                    return (
                        the_number.toLocaleString(undefined, this.cardano.lovelace_format) +
                        ` ₳`
                    );
                },
                toAda(lovelace) {
                    if (typeof lovelace === "bigint") {
                        return lovelace / 1000000n;
                    }
                    return lovelace / 1000000;
                },
                toLovelace(Ada) {
                    if (typeof Ada === "bigint") {
                        return Ada * 1000000n
                    }
                    return Ada * 1000000;
                },
                toUint8Array(hexString) {
                    return Uint8Array.from(Buffer.from(hexString, "hex"));
                },
                fromHex(string) {
                    return Buffer.from(string, "hex");
                },
                toHex(bytes) {
                    return Buffer.from(bytes).toString("hex");
                },
                toAscii(bytes) {
                    return Buffer.from(bytes).toString("ascii");
                },
                fromAscii(string) {
                    return Buffer.from(string, "ascii");
                },
                // Look for wallets for up to 10 s. The picker is usable from the first
                // wallet found; a wallet that registers late still appears. Calling it
                // again ("Check again") restarts the window.
                checkForCardano() {
                    clearTimeout(this.discoveryTimer);
                    const started = Date.now();
                    if (this.cardano.status !== "connected") {
                        this.cardano.status = "init";
                    }
                    const tick = () => {
                        if (this.cardano.status === "connected") {
                            return;
                        }
                        const wallets = discoverWallets(readWindowCardano());
                        const keys = wallets.map((w) => w.key).join("\u0000");
                        if (keys !== this.cardano.Wallets.map((w) => w.key).join("\u0000")) {
                            this.cardano.Wallets = wallets;
                        }
                        const elapsed = Date.now() - started;
                        if (wallets.length) {
                            this.cardano.status = "found";
                        } else {
                            this.cardano.status = elapsed >= DISCOVERY_WINDOW_MS ? "notfound" : "init";
                        }
                        if (elapsed >= DISCOVERY_WINDOW_MS) {
                            return;
                        }
                        this.discoveryTimer = setTimeout(tick, elapsed < DISCOVERY_FAST_MS ? 200 : 1000);
                    };
                    tick();
                },
                async connect(registration) {
                    try {
                        const api = await registration.handle.enable();
                        this.cardano.Wallet = wrapApi(api);
                        this.cardano.ActiveWallet = registration;
                        this.cardano.status = "connected";
                        this.$emit("connected");
                    } catch (e) {
                        console.error("Connection Error:", e);
                        throw e;
                    }
                },
                async getWalletNetwork() {
                    return await this.cardano.Wallet.getNetworkId();
                },
                changeWallet() {
                    this.cardano.ActiveWallet = false;
                    this.cardano.Wallet = null;
                    this.cardano.status = this.cardano.Wallets.length ? "found" : "notfound";
                    this.cardano.change_address = null;
                },
                // The address the unfracked outputs go to: getChangeAddress(), which
                // CIP-30 defines for this, then the first used address, then the first
                // unused one. Returns null when the wallet gives none.
                async getChangeAddress() {
                    const sources = [
                        ["getChangeAddress", async () => this.cardano.Wallet.getChangeAddress()],
                        ["getUsedAddresses", async () => (await this.cardano.Wallet.getUsedAddresses())[0]],
                        ["getUnusedAddresses", async () => (await this.cardano.Wallet.getUnusedAddresses())[0]],
                    ];
                    for (const [label, read] of sources) {
                        try {
                            const address = await read();
                            if (typeof address !== "string" || address === "") {
                                continue;
                            }
                            if (/^addr/.test(address)) {
                                return CSL.Address.from_bech32(address);
                            }
                            return CSL.Address.from_bytes(this.fromHex(address));
                        } catch (e) {
                            console.info(`No address from ${label}:`, e);
                        }
                    }
                    return null;
                },
                // The stake address is shown for information only; a wallet without a
                // reward address (enterprise-only accounts) still connects.
                async getStakeKey() {
                    try {
                        const rewardAddresses = await this.cardano.Wallet.getRewardAddresses();
                        if (!Array.isArray(rewardAddresses) || !rewardAddresses.length) {
                            return null;
                        }
                        return CSL.Address.from_bytes(this.toUint8Array(rewardAddresses[0])).to_bech32();
                    } catch (e) {
                        console.info("No reward address:", e);
                        return null;
                    }
                },
                prepareTransaction(parameters) {
                    const txBuilderConfig = CSL.TransactionBuilderConfigBuilder.new()
                        .fee_algo(
                            CSL.LinearFee.new(
                                CSL.BigNum.from_str(String(parameters.minFeeA)),
                                CSL.BigNum.from_str(String(parameters.minFeeB))
                            )
                        )
                        .coins_per_utxo_byte(
                            CSL.BigNum.from_str(String(parameters.coinsPerUtxoByte))
                        )
                        .pool_deposit(
                            CSL.BigNum.from_str(String(parameters.poolDeposit))
                        )
                        .key_deposit(
                            CSL.BigNum.from_str(String(parameters.keyDeposit))
                        )
                        .max_value_size(parameters.maxValSize)
                        .max_tx_size(parameters.maxTxSize)
                        // Placeholder prices: the app builds no script transactions.
                        .ex_unit_prices(
                            CSL.ExUnitPrices.new(
                                CSL.UnitInterval.new(
                                    CSL.BigNum.from_str("1"),
                                    CSL.BigNum.from_str("1")
                                ),
                                CSL.UnitInterval.new(
                                    CSL.BigNum.from_str("1"),
                                    CSL.BigNum.from_str("1")
                                )
                            )
                        )
                        .build();

                    return CSL.TransactionBuilder.new(txBuilderConfig);
                },
            },
        });
    },
};
