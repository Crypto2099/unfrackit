<template>
    <v-app>
        <v-app-bar app color="primary" dark>
            <v-container class="d-flex">
                <div class="d-flex align-center">
                    <v-icon class="me-2">mdi-lan</v-icon>
                    UnFrackIt
                </div>

                <v-spacer></v-spacer>

                <v-btn href="https://github.com/crypto2099/unfrackit/releases/latest/" target="_blank" text>
                    <span class="mr-2">Latest Release</span>
                    <v-icon>mdi-open-in-new</v-icon>
                </v-btn>
            </v-container>

        </v-app-bar>

        <v-main>
            <v-container class="my-16">
                <template v-if="cardano.status === `init`">
                    <p>
                        Checking for Cardano wallets... </p>
                    <v-progress-linear indeterminate height="24" color="primary"></v-progress-linear>
                </template>
                <template v-if="cardano.status === `notfound`">
                    <v-alert color="red" outlined border="left">
                        Sorry, we could not detect any Cardano light wallets installed in your browser.
                    </v-alert>
                </template>
                <template v-if="cardano.status === `found`">
                    <v-btn color="primary" x-large @click="connectModal = true">
                        Connect Wallet
                    </v-btn>
                </template>
                <template v-if="cardano.status === `connected`">
                    <v-row align="center" class="mb-4">
                        <v-chip x-large label class="me-2 text-capitalize">
                            <v-img :src="cardano.ActiveWallet.icon" class="me-2" contain height="24" width="24"></v-img>
                            {{ cardano.ActiveWallet.name.replace(' Wallet', '') }} Connected
                        </v-chip>
                        <v-btn color="secondary" x-large @click="disconnect"
                               :disabled="gettingUTxO || analyzingUTxO || (pendingTx !== null)">
                            Disconnect
                        </v-btn>
                    </v-row>
                    <h3>UnFrackIt Settings</h3>
                    <v-row align="center" class="mb-4">
                        <v-col cols="12" class="mb-4 mt-12">
                            <v-slider label="Bundle Size" min="1" max="60" thumb-label="always" persistent-hint
                                      hint="Tokens from the same Policy ID will be collected up to bundle size. Policies with more tokens than bundle size will be split into multiple UTxO. Tokens from different policies will be collected up to 1/2 bundle size."
                                      v-model="settings.bundleSize"></v-slider>
                        </v-col>
                        <v-col>
                            <v-switch v-model="settings.isolateFungible" label="Isolate Fungible Tokens?"
                                      persistent-hint
                                      hint="Should fungible tokens be placed on their own, individual UTxO? This can decrease fees and errors when interacting with DEXes and paying with fungible tokens.">

                            </v-switch>
                        </v-col>
                        <v-col>
                            <v-switch v-model="settings.isolateNonfungible" label="Isolate Non-Fungible Tokens?"
                                      persistent-hint
                                      hint="Should non-fungible tokens be placed on their own, policy-specific individual UTxO? This can decrease fees and errors when interacting with marketplaces or sending NFTs."></v-switch>
                        </v-col>
                        <v-col>
                            <v-switch v-model="settings.splitLovelace" label="Sub-Divide ADA-Only UTxO?" persistent-hint
                                      hint="Should we break ADA-only UTxO down into smaller spendable UTxO? This can decrease fees and increase the wallet's capability to handle multiple concurrent payments"></v-switch>
                        </v-col>
                    </v-row>
                    <p v-if="stakeKey !== null">
                        <strong>Connected Account:</strong> {{ stakeKey }} </p>
                    <p v-if="changeAddress !== null">
                        <strong>Change Address:</strong> {{ changeAddress.to_bech32() }} </p>
                    <template v-if="gettingUTxO">
                        <h3>Checking wallet UTxO balance...</h3>
                        <v-progress-linear indeterminate height="24" class="mb-4"></v-progress-linear>
                    </template>
                    <template v-if="UTxOSet !== null">
                        <p>
                            {{ UTxOSet.len() }} UTxO found on the address!
                            <v-btn color="primary" @click="checkWalletBalance" small class="ms-4"
                                   :disabled="gettingUTxO || analyzingUTxO || (pendingTx !== null)">
                                <v-icon class="me-2">mdi-reload</v-icon>
                                Check Again
                            </v-btn>
                        </p>
                        <p>
                            <strong>{{ formatAda(toAda(analysis.lovelace)) }}</strong> present in wallet. </p>
                        <p>
                            <strong>{{ analysis.total_policies }}</strong> token policies with
                            <strong>{{ analysis.total_tokens }}</strong> total, discrete tokens present in wallet. </p>

                    </template>
                    <template v-if="analyzingUTxO">
                        <h3>Analyzing UTxO Set...</h3>
                        <v-progress-linear indeterminate height="24" class="mb-4"></v-progress-linear>
                    </template>
                    <template v-else-if="ProposedUTxO.optimized !== null">
                        <template v-if="ProposedUTxO.optimized === true">
                            <h2>Analysis Complete.</h2>
                            <v-alert color="primary" border="left" dark>
                                Your wallet is already optimized! We can't find any additional UTxO changes to make at
                                this time!
                            </v-alert>
                        </template>
                        <template v-else>
                            <h2>Analysis Complete.</h2>
                            <v-btn x-large color="primary" @click="unfrack = true" class="my-4"
                                   :disabled="(pendingTx !== null)">
                                Click here to UnFrack Your Wallet
                            </v-btn>
                        </template>
                        <v-alert class="my-4" dark color="primary" border="left" v-if="pendingTx !== null">
                            You have a current, pending transaction to UnFrack your wallet submitted!<br /> Please wait
                            while we confirm that your transaction has been confirmed on the blockchain before checking
                            your wallet again.<br /><br /> Transaction ID: {{ pendingTx }}
                        </v-alert>
                    </template>
                </template>
            </v-container>
        </v-main>

        <v-footer>
            <v-container>
                <p>
                    Made with
                    <v-icon color="red">mdi-heart</v-icon>
                    by the team at <a href="https://dripdropz.io" target="_blank">DripDropz</a>
                </p>
            </v-container>

        </v-footer>
        <v-dialog v-model="connectModal" max-width="512">
            <v-card>
                <v-card-title>Connect Your Wallet</v-card-title>
                <v-card-text>
                    <v-btn v-for="wallet in cardano.Wallets" :key="wallet.name" block class="wallet-btn mb-2 text-start"
                           x-large @click="connectTo(wallet)" :loading="wallet.loading">
                        <v-img :src="wallet.icon" max-width="24" height="24" class="me-2" contain
                               :alt="wallet.name"></v-img>
                        Connect {{ wallet.name.replace(" Wallet", "") }}
                    </v-btn>
                </v-card-text>
            </v-card>
        </v-dialog>
        <v-dialog v-model="unfrack" max-width="512" persistent>
            <v-card>
                <v-card-text class="text-center pt-4">
                    <h3>UnFrackIt is brought to you by the team at</h3>
                    <v-img class="mx-auto" :src="require('./assets/dripdropz.svg')" alt="DripDropz" contain
                           max-width="256"></v-img>
                </v-card-text>
                <v-card-text>
                    If you appreciate this service and would like to support our team there are three ways you can help!
                </v-card-text>
                <v-card-text>
                    <ul class="body-1">
                        <li>
                            Visit and use <a href="https://dripdropz.io" target="_blank">DripDropz.io</a> and claim your
                            free tokens every epoch!
                        </li>
                        <li>
                            Mint a Drippyz NFT from <a href="https://drippyz.buffybot.io" target="_blank">https://drippyz.buffybot.io</a>!
                        </li>
                        <li>
                            Include a tip in your transaction by clicking the button below or sending it to <a
                                href="https://handle.me/unfrackit" target="_blank"
                                class="font-weight-bold">$unfrackit</a>
                        </li>
                    </ul>
                </v-card-text>
                <v-card-text class="text-center">
                    <template v-if="ProposedUTxO.addTip">
                        <p class="body-1">
                            Please choose a tip amount: </p>
                        <v-btn-toggle v-model="ProposedUTxO.tip" tile group color="primary">
                            <v-btn value="1">1 &#8371;</v-btn>
                            <v-btn value="5">5 &#8371;</v-btn>
                            <v-btn value="10">10 &#8371;</v-btn>
                            <v-btn value="0">No Tip For You!</v-btn>
                        </v-btn-toggle>
                    </template>
                    <template v-else>
                        <v-btn large color="primary" @click="ProposedUTxO.addTip = true; ProposedUTxO.tip = '1'">
                            Add a Tip!
                        </v-btn>
                    </template>
                </v-card-text>
                <v-card-actions class="justify-space-between">
                    <v-btn large color="secondary" @click="unfrack = false">Cancel</v-btn>
                    <v-btn large color="primary" @click="doUnFrack">
                        LFG! UnFrack My Wallet!
                    </v-btn>
                </v-card-actions>
            </v-card>
        </v-dialog>
    </v-app>
</template>

<script>
import debounce from "lodash.debounce";
import * as CSL from "./lib/CardanoSerializationLib.ts";
import axios from "axios";

const analysis_format = {
    lovelace: 0,
    total_tokens: 0,
    total_policies: 0,
    fungible: {},
    nonfungible: {},
    tokens: {}
};

const default_settings = {
    bundleSize: 30,
    extraADA: 5,
    isolateFungible: false,
    splitLovelace: true,
    isolateNonfungible: false
};

const default_proposed = {
    input_lovelace: 0,
    output_lovelace: 0,
    total_tokens: 0,
    token_keep: 0,
    fees: 0,
    addTip: false,
    tip: 0,
    inputs: [],
    inputs_json: {},
    outputs: [],
    outputs_json: [],
    optimized: null,
    steps: [],
    staging: {
        inputs: {},
        outputs: [],
        balance_tokens: []
    }
};
export default {
    name: "App",

    components: {},

    data: () => ({
        connectModal: false,
        analyzingUTxO: false,
        gettingUTxO: false,
        stakeKey: null,
        changeAddress: null,
        UTxOSet: null,
        settings: null,
        unfrack: false,
        analyzedUTxO: [],
        analysis: JSON.parse(JSON.stringify(analysis_format)),
        ProposedUTxO: JSON.parse(JSON.stringify(default_proposed)),
        inputTokens: [],
        pendingTx: null,
        watchingTx: null,
    }),
    methods: {
        showError(msg, title) {
            this.$swal.fire({
                icon: "error",
                title: title || "Error",
                html: msg,
                showConfirmButton: true,
                allowOutsideClick: false
            });
        },
        showSuccess(msg, title) {
            this.$swal.fire({
                icon: "check",
                title: title || "Success",
                html: msg,
                showConfirmButton: true,
                allowOutsideClick: false
            });
        },
        async connectTo(wallet) {
            await this.connect(wallet);
            this.stakeKey = await this.getStakeKey();
            this.changeAddress = await this.getChangeAddress();
            this.connectModal = false;
            await this.checkWalletBalance();
        },
        disconnect() {
            this.stakeKey = null;
            this.changeAddress = null;
            this.UTxOSet = null;
            this.analyzedUTxO = [];
            this.analysis = JSON.parse(JSON.stringify(analysis_format));
            this.ProposedUTxO = JSON.parse(JSON.stringify(default_proposed));
            this.changeWallet();
        },
        async checkWalletBalance() {
            this.gettingUTxO = true;
            this.UTxOSet = null;
            this.analyzedUTxO = [];
            this.analysis = JSON.parse(JSON.stringify(analysis_format));
            this.ProposedUTxO = JSON.parse(JSON.stringify(default_proposed));
            this.UTxOSet = await this.getUTxO();
            this.gettingUTxO = false;
            await this.analyzeUTxO();
        },
        doBalanceTxn() {
            // Remove any ADA-only UTXO Outputs
            for (const i in this.ProposedUTxO.outputs) {
                const output = this.ProposedUTxO.outputs[i];

                if (output.address().to_bech32() === this.changeAddress.to_bech32() && (output.amount().multiasset() === undefined || output.amount().multiasset() === null)) {
                    console.log("Removing pure Lovelace UTXO from outputs!");
                    this.ProposedUTxO.outputs.splice(parseInt(i), 1);
                }
            }

            for (const j in this.ProposedUTxO.outputs_json) {
                const output = this.ProposedUTxO.outputs_json[j];

                if (output.address === this.changeAddress.to_bech32() && (output.amount.multiasset === null || output.amount.multiasset === undefined)) {
                    console.log("Removing pure lovelace UTXO from outputs JSON!");
                    this.ProposedUTxO.outputs_json.splice(parseInt(j), 1);
                }
            }

            this.ProposedUTxO.token_keep = 0;

            for (const output of this.ProposedUTxO.outputs_json) {
                try {
                    this.ProposedUTxO.token_keep += parseInt(output.amount.coin);
                } catch (e) {
                    console.error("Error attempting to add output coin amount!", e);
                }
            }

            const tx_size = 16384 - this.estimateSize(this.ProposedUTxO);
            let estimated_fees = (tx_size * 52) + 155381;
            let lovelace_balance = this.ProposedUTxO.input_lovelace - this.ProposedUTxO.token_keep - estimated_fees;
            console.log(`Have ${lovelace_balance} Lovelace left to split up!`);

            let iterations = 1;

            while (lovelace_balance < 1000000) {
                if (iterations >= 100) {
                    throw Error("Could not add enough change to balance!");
                }
                console.log(`Have ${lovelace_balance} Lovelace left to split up!`);

                for (const utxo_input of this.analyzedUTxO) {
                    if (utxo_input.output.amount.multiasset === null) {
                        // Lovelace-only input, let's grab it!
                        const tx_id = utxo_input.input.transaction_id + '#' + utxo_input.input.index;
                        if (this.ProposedUTxO.inputs_json[tx_id] === undefined) {
                            this.ProposedUTxO.inputs_json[tx_id] = utxo_input;
                            this.ProposedUTxO.inputs.add_input(
                                this.changeAddress,
                                CSL.TransactionInput.from_json(JSON.stringify(utxo_input.input)),
                                CSL.Value.from_json(JSON.stringify(utxo_input.output.amount))
                            );
                            let input_coin_amt;
                            try {
                                input_coin_amt = parseInt(utxo_input.output.amount.coin);
                            } catch (e) {
                                console.error("Could not get input coin amount?", e);
                                console.info(utxo_input);
                                input_coin_amt = 0;
                            }
                            this.ProposedUTxO.input_lovelace += input_coin_amt;
                        }
                    }
                }

                const tx_size = 16384 - this.estimateSize(this.ProposedUTxO);
                let estimated_fees = (tx_size * 52) + 155381;
                lovelace_balance = this.ProposedUTxO.input_lovelace - this.ProposedUTxO.token_keep - estimated_fees;
                console.log(`Have ${lovelace_balance} Lovelace left to split up!`);
            }

            if (lovelace_balance > 100000000 && this.settings.splitLovelace) {
                const fee_increase = 420;
                estimated_fees += fee_increase;
                lovelace_balance -= fee_increase;
                const splits = [
                    Math.floor(lovelace_balance * 0.5),
                    Math.floor(lovelace_balance * 0.15),
                    Math.floor(lovelace_balance * 0.1),
                    Math.floor(lovelace_balance * 0.1),
                    Math.floor(lovelace_balance * 0.05),
                    Math.floor(lovelace_balance * 0.05),
                    Math.floor(lovelace_balance * 0.05)
                ];

                let lovelace_split = 0;

                for (const value of splits) {
                    lovelace_split += value;
                }

                const lovelace_remainder = lovelace_balance - lovelace_split;
                if (lovelace_remainder) {
                    splits[4] += lovelace_remainder;
                }

                for (const value of splits) {
                    const output = CSL.TransactionOutputBuilder
                        .new()
                        .with_address(this.changeAddress)
                        .next()
                        .with_coin(
                            CSL.BigNum.from_str(value.toString())
                        ).build();
                    this.ProposedUTxO.outputs.push(output);
                    this.ProposedUTxO.outputs_json.push(JSON.parse(output.to_json()));
                }

            } else {
                const fee_increase = 60;
                estimated_fees += fee_increase;
                lovelace_balance -= fee_increase;

                const output = CSL.TransactionOutputBuilder
                    .new()
                    .with_address(this.changeAddress)
                    .next()
                    .with_coin(
                        CSL.BigNum.from_str(lovelace_balance.toString())
                    ).build();
                this.ProposedUTxO.outputs.push(output);
                this.ProposedUTxO.outputs_json.push(JSON.parse(output.to_json()));
            }

            this.ProposedUTxO.fees = estimated_fees;

        },
        async doUnFrack() {
            const unfrackit_address = 'addr1v8v7p3truluykd2jy2g5a55h4rgt50q0lk89tfjtwqe9tggg5jenv';
            if (this.ProposedUTxO.tip > 0) {
                // Check if we already have a tip in the output sets... Don't want to add multiple tips!
                const tip_amt = this.toLovelace(this.ProposedUTxO.tip);
                let tip_found = false;
                for (const output of this.ProposedUTxO.outputs_json) {
                    if (output.address === unfrackit_address) {
                        output.amount.coin = tip_amt;
                        tip_found = true;
                    }
                }
                if (!tip_found) {
                    const output = CSL.TransactionOutputBuilder
                        .new()
                        .with_address(
                            CSL.Address.from_bech32(unfrackit_address)
                        ).next()
                        .with_coin(
                            CSL.BigNum.from_str(tip_amt.toString())
                        ).build();
                    this.ProposedUTxO.outputs.push(output);
                    this.ProposedUTxO.outputs_json.push(JSON.parse(output.to_json()));
                } else {
                    console.log("Changing tip amount!");
                    for (const i in this.ProposedUTxO.outputs) {
                        const output = this.ProposedUTxO.outputs[i];
                        if (output.address().to_bech32() === unfrackit_address) {
                            console.log("Updating tip amount!", output.amount());
                            output.amount().set_coin(CSL.BigNum.from_str(tip_amt.toString()));
                        }
                    }
                }

                this.doBalanceTxn();
            } else {
                // Need to remove an output if we already added a tip previously
                for (const i in this.ProposedUTxO.outputs_json) {
                    const output = this.ProposedUTxO.outputs_json[i];
                    if (output.address === unfrackit_address) {
                        this.ProposedUTxO.outputs_json.splice(i, 1);
                    }
                }
                for (const j in this.ProposedUTxO.outputs) {
                    const output = this.ProposedUTxO.outputs[j];
                    if (output.address().to_bech32() === unfrackit_address) {
                        this.ProposedUTxO.outputs.splice(j, 1);
                    }
                }
                this.doBalanceTxn();
            }

            const txBuilder = await this.prepareTransaction();

            txBuilder.set_inputs(this.ProposedUTxO.inputs);

            for (const output of this.ProposedUTxO.outputs) {
                txBuilder.add_output(output);
            }

            txBuilder.set_fee(CSL.BigNum.from_str(this.ProposedUTxO.fees.toString()));

            let txBuilt;
            try {
                txBuilt = await txBuilder.build();
            } catch (e) {
                console.error("Error Building Transaction", e);
                return;
            }

            const witnessSet = CSL.TransactionWitnessSet.new();

            const tx = CSL.Transaction.new(txBuilt, witnessSet);

            let witness;
            try {
                witness = await this.cardano.Wallet.signTx(tx.to_hex(), true);
            } catch (e) {
                console.error("Failed to sign?", e);
                return;
            }

            const totalVkeys = CSL.Vkeywitnesses.new();

            const addWitness = CSL.TransactionWitnessSet.from_bytes(this.fromHex(witness));
            const addVkeys = addWitness.vkeys();
            if (addVkeys) {
                for (let i = 0; i < addVkeys.len(); i++) {
                    totalVkeys.add(addVkeys.get(i));
                }
            }

            witnessSet.set_vkeys(totalVkeys);
            const signedTx = await CSL.Transaction.new(
                tx.body(),
                witnessSet
            );

            try {
                const response = await this.cardano.Wallet.submitTx(
                    this.toHex(signedTx.to_bytes())
                );
                // Response === TX ID
                console.log("Result", response);
                if (response) {
                    this.showSuccess(`Transaction ID ${response} has been submitted to the blockchain.<br />Please allow a few minutes for the transaction to be confirmed.`, `You UnFracked It!`);
                    this.pendingTx = response;
                    this.unfrack = false;
                }
            } catch (e) {
                console.error("Submit Error", e);
                this.showError(`Sorry, we couldn't submit your transaction.<br />Please try again later!`);
            }
        },
        getAllTokensSorted(entry_tokens) {
            const all_tokens = [];
            for (const [policy, tokens] of Object.entries(entry_tokens)) {
                const policy_tokens = {
                    policy_id: policy,
                    tokens: []
                };
                for (const [token_id, quantity] of Object.entries(tokens)) {
                    policy_tokens.tokens.push({
                        policy_id: policy,
                        token_id: token_id,
                        quantity: quantity
                    });
                }

                policy_tokens.tokens.sort((a, b) => {
                    const tokenA = a.token_id;
                    const tokenB = b.token_id;

                    if (tokenA < tokenB) {
                        return -1;
                    }

                    if (tokenA > tokenB) {
                        return 1;
                    }

                    let quantity_diff = 0;
                    try {
                        quantity_diff = parseInt(a.quantity) - parseInt(b.quantity);
                    } catch (e) {
                        console.error("Could not generate quantity diff?", a.quantity, b.quantity);
                        throw e;
                    }

                    return quantity_diff;
                });

                all_tokens.push(policy_tokens);
            }

            all_tokens.sort((a, b) => {
                const policyA = a.policy_id;
                const policyB = b.policy_id;

                if (policyA < policyB) {
                    return -1;
                }

                if (policyA > policyB) {
                    return 1;
                }

                return 0;
            });

            return all_tokens;
        },
        handleBundled(token_outputs, add_inputs) {
            loopOutputs: for (const output_tokens of token_outputs) {
                const output = this.makeOutput(output_tokens);

                const bail_out_level = 1024;
                const tx_size = this.estimateSize(this.ProposedUTxO);
                console.log("Tx Size Now:", tx_size);
                if (tx_size < bail_out_level) {
                    console.log("We don't have room to process anymore! Bail out!");
                    break;
                }

                if (add_inputs === true) {
                    for (const token of output_tokens) {
                        for (const utxo_input of this.analyzedUTxO) {
                            if (utxo_input.output.amount.multiasset === null) {
                                continue;
                            }
                            if (utxo_input.output.amount.multiasset[token.policy_id] === undefined) {
                                continue;
                            }
                            if (utxo_input.output.amount.multiasset[token.policy_id][token.token_id] === undefined) {
                                continue;
                            }

                            const input_amount = JSON.stringify(utxo_input.output.amount);
                            const output_amount = JSON.stringify(JSON.parse(output.to_json()).amount);

                            if (input_amount === output_amount) {
                                continue loopOutputs;
                            }

                            const tx_id = utxo_input.input.transaction_id + '#' + utxo_input.input.index;
                            if (this.ProposedUTxO.inputs_json[tx_id] === undefined) {
                                this.ProposedUTxO.inputs_json[tx_id] = utxo_input;
                                this.ProposedUTxO.inputs.add_input(
                                    this.changeAddress,
                                    CSL.TransactionInput.from_json(JSON.stringify(utxo_input.input)),
                                    CSL.Value.from_json(JSON.stringify(utxo_input.output.amount))
                                );
                                let input_coin_amt;
                                try {
                                    input_coin_amt = parseInt(utxo_input.output.amount.coin);
                                } catch (e) {
                                    console.error("Could not get input coin amount?", e);
                                    console.info(utxo_input);
                                    input_coin_amt = 0;
                                }
                                this.ProposedUTxO.input_lovelace += input_coin_amt;
                            }

                        }
                    }
                }

                this.ProposedUTxO.outputs.push(output);
                this.ProposedUTxO.outputs_json.push(JSON.parse(output.to_json()));
            }
        },
        findNeededInputs(output) {
            const inputs = {};


            const mock_output = this.makeOutput(output);

            for (const token of output) {
                for (const utxo_input of this.analyzedUTxO) {
                    if (utxo_input.output.amount.multiasset === null) {
                        continue;
                    }
                    if (utxo_input.output.amount.multiasset[token.policy_id] === undefined) {
                        continue;
                    }
                    if (utxo_input.output.amount.multiasset[token.policy_id][token.token_id] === undefined) {
                        continue;
                    }

                    const tx_id = utxo_input.input.transaction_id + '#' + utxo_input.input.index;
                    if (inputs[tx_id] === undefined) {
                        inputs[tx_id] = utxo_input;
                    }
                }
            }

            if (Object.entries(inputs).length === 1) {
                const mock_input = Object.entries(inputs)[0][1];

                const input_amount = JSON.stringify(mock_input.output.amount);
                const output_amount = JSON.stringify(JSON.parse(mock_output.amount().to_json()));

                if (input_amount === output_amount) {
                    console.log("UTxO already optimized...");
                    return -1;
                }
            }

            return inputs;
        },
        async analyzeUTxO() {
            this.analyzingUTxO = true;

            for (let i = 0; i < this.UTxOSet.len(); i++) {
                const UTxO = this.UTxOSet.get(i);
                const JSONUTxO = JSON.parse(await UTxO.to_json());
                this.analysis.lovelace += parseInt(JSONUTxO.output.amount.coin);
                if (JSONUTxO.output.amount.multiasset !== null) {
                    for (const [policy, tokens] of Object.entries(JSONUTxO.output.amount.multiasset)) {
                        if (this.analysis.tokens[policy] === undefined) {
                            this.analysis.tokens[policy] = {};
                        }
                        for (const [token_id, quantity] of Object.entries(tokens)) {
                            if (this.analysis.tokens[policy][token_id] === undefined) {
                                this.analysis.tokens[policy][token_id] = 0;
                            }
                            this.analysis.tokens[policy][token_id] += parseInt(quantity);
                        }
                    }
                }
                this.analyzedUTxO.push(JSONUTxO);
            }

            if (Object.entries(this.analysis.tokens).length) {
                for (const [policy, tokens] of Object.entries(this.analysis.tokens)) {
                    this.analysis.total_policies++;
                    for (const [token_id, quantity] of Object.entries(tokens)) {
                        this.analysis.total_tokens++;
                        let token_type;
                        if (quantity > 1) {
                            token_type = 'fungible';
                        } else {
                            token_type = 'nonfungible';
                        }
                        if (this.analysis[token_type][policy] === undefined) {
                            this.analysis[token_type][policy] = {};
                        }
                        this.analysis[token_type][policy][token_id] = quantity;
                        delete this.analysis.tokens[policy][token_id];
                    }
                    delete this.analysis.tokens[policy];
                }
            }

            this.ProposedUTxO.inputs = CSL.TxInputsBuilder.new();

            const all_fungibles = this.getAllTokensSorted(this.analysis.fungible);
            const all_nonfungible = this.getAllTokensSorted(this.analysis.nonfungible);

            let ideal_fungible_outputs = this.process('fungible', all_fungibles);
            let ideal_nonfungible_outputs = this.process('nonfungible', all_nonfungible);

            let mock = {
                inputs: {},
                outputs: []
            };

            for (const output of ideal_fungible_outputs) {
                const inputs_needed = this.findNeededInputs(output);
                if (inputs_needed === -1) {
                    continue;
                }

                mock.outputs.push(output);

                for (const [txid, input] of Object.entries(inputs_needed)) {
                    if (mock.inputs[txid] === undefined) {
                        mock.inputs[txid] = input;
                    }
                }

                const size = this.calcTxSize(mock);

                if (size >= 15360) {
                    console.log("Size is too large, we should stop now!", size);
                    this.calcTxSize(mock, true);
                    for (const [txid, input] of Object.entries(mock.inputs)) {
                        if (this.ProposedUTxO.inputs_json[txid] === undefined) {
                            this.ProposedUTxO.inputs_json[txid] = input;
                            this.ProposedUTxO.inputs.add_input(
                                this.changeAddress,
                                CSL.TransactionInput.from_json(JSON.stringify(input.input)),
                                CSL.Value.from_json(JSON.stringify(input.output.amount))
                            );
                            const input_coin_amt = parseInt(input.output.amount.coin);
                            this.ProposedUTxO.input_lovelace += input_coin_amt;
                        }
                    }
                    this.handleBundled(mock.outputs);
                    break;
                }

            }

            for (const output of ideal_nonfungible_outputs) {
                const inputs_needed = this.findNeededInputs(output);
                if (inputs_needed === -1) {
                    continue;
                }

                mock.outputs.push(output);

                for (const [txid, input] of Object.entries(inputs_needed)) {
                    if (mock.inputs[txid] === undefined) {
                        mock.inputs[txid] = input;
                    }
                }

                const size = this.calcTxSize(mock);

                if (size >= 15360) {
                    console.log("Size is too large, we should stop now!", size);
                    this.calcTxSize(mock, true);
                    for (const [txid, input] of Object.entries(mock.inputs)) {
                        if (this.ProposedUTxO.inputs_json[txid] === undefined) {
                            this.ProposedUTxO.inputs_json[txid] = input;
                            this.ProposedUTxO.inputs.add_input(
                                this.changeAddress,
                                CSL.TransactionInput.from_json(JSON.stringify(input.input)),
                                CSL.Value.from_json(JSON.stringify(input.output.amount))
                            );
                            const input_coin_amt = parseInt(input.output.amount.coin);
                            this.ProposedUTxO.input_lovelace += input_coin_amt;
                        }
                    }
                    this.handleBundled(mock.outputs);
                    break;
                }
            }

            this.calcTxSize(mock, true);

            if (this.ProposedUTxO.inputs.length === 0 || this.ProposedUTxO.outputs.length === 0) {
                this.ProposedUTxO.optimized = true;
                this.analyzingUTxO = false;
                return;
            }

            this.ProposedUTxO.optimized = false;


            for (const output of this.ProposedUTxO.outputs_json) {
                try {
                    this.ProposedUTxO.token_keep += parseInt(output.amount.coin);
                } catch (e) {
                    console.error("Error attempting to add output coin amount!", e);
                }
            }

            this.analyzingUTxO = false;
        },
        calcTxSize(mock, doBackfill) {
            const max_tx = 16384;
            const min_sig = 240;
            const size_per_input = 33;
            const size_per_output = 60;
            const fee_size = 6;

            const output_tokens = [];
            const balance_tokens = {};
            const backfill = {};

            const input_ct = Object.entries(mock.inputs).length;

            let txn_size = min_sig + fee_size;
            txn_size += input_ct * size_per_input;

            for (const tokens of mock.outputs) {
                txn_size += size_per_output;
                for (const token of tokens) {
                    const asset_id = token.policy_id + '.' + token.token_id;
                    txn_size += token.policy_id.length;
                    txn_size += token.token_id.length;
                    output_tokens.push(asset_id);
                }
            }

            for (const [txid, utxo] of Object.entries(mock.inputs)) {
                if (txid) {
                    //
                }
                if (utxo.output.amount.multiasset === null) {
                    continue;
                }


                for (const [policy_id, tokens] of Object.entries(utxo.output.amount.multiasset)) {
                    let policy_txn_size = policy_id.length;
                    let policy_token_txn_size = 0;
                    for (const [token_id, quantity] of Object.entries(tokens)) {
                        const asset_id = policy_id + '.' + token_id;
                        if (output_tokens.includes(asset_id)) {
                            continue;
                        }
                        balance_tokens[asset_id] = quantity;
                        policy_token_txn_size += token_id.length;

                        if (backfill[policy_id] === undefined) {
                            backfill[policy_id] = {};
                        }
                        if (backfill[policy_id][token_id] === undefined) {
                            backfill[policy_id][token_id] = 0;
                        }
                        backfill[policy_id][token_id] += parseInt(quantity);
                    }
                    txn_size += policy_txn_size + policy_token_txn_size;
                }
            }

            if ((txn_size >= max_tx || doBackfill === true) && Object.entries(balance_tokens).length) {
                if (doBackfill === true) {
                    console.log("Doing backfill!");
                }
                const backfill_fungible = {};
                const backfill_nonfungible = {};

                let fungible_ct = 0, nonfungible_ct = 0;

                for (const [policy_id, tokens] of Object.entries(backfill)) {
                    for (const [token_id, quantity] of Object.entries(tokens)) {
                        if (quantity > 1) {
                            if (backfill_fungible[policy_id] === undefined) {
                                backfill_fungible[policy_id] = {};
                            }
                            fungible_ct++;
                            backfill_fungible[policy_id][token_id] = quantity;
                        } else {
                            if (backfill_nonfungible[policy_id] === undefined) {
                                backfill_nonfungible[policy_id] = {};
                            }
                            nonfungible_ct++;
                            backfill_nonfungible[policy_id][token_id] = quantity;
                        }
                    }
                }

                if (fungible_ct) {
                    mock.outputs = mock.outputs.concat(this.process('fungible', this.getAllTokensSorted(backfill_fungible)));
                }

                if (nonfungible_ct) {
                    mock.outputs = mock.outputs.concat(this.process('nonfungible', this.getAllTokensSorted(backfill_nonfungible)));
                }

                return this.calcTxSize(mock);
            }

            return txn_size;
        },
        estimateSize(analysis, count_input) {
            const max_tx = 16384;
            const max_utxo = 5000;
            const min_sig = 240;
            const size_per_input = 33;
            const size_per_output = 60;
            const fee_size = 6;

            if (count_input !== true) {
                count_input = false;
            }

            let txn_size = max_tx - fee_size - min_sig;

            let inputs_size = analysis.inputs.len() * size_per_input;
            txn_size -= inputs_size;

            if (count_input) {
                let input_token_size = 0;
                for (const [key, input] of Object.entries(analysis.inputs_json)) {
                    if (key) {
                        //
                    }
                    if (input.output.amount.multiasset !== null) {
                        for (const [policy, tokens] of Object.entries(input.output.amount.multiasset)) {
                            input_token_size += policy.length;
                            for (const [token_id, quantity] of Object.entries(tokens)) {
                                input_token_size += token_id.length;
                                input_token_size += quantity.length;
                            }
                        }
                    }
                }
                txn_size -= input_token_size;
            }

            for (const output of analysis.outputs_json) {
                let output_size = size_per_output;
                if (output.amount.multiasset !== null) {
                    for (const [policy, tokens] of Object.entries(output.amount.multiasset)) {
                        output_size += policy.length;
                        for (const [token_id, quantity] of Object.entries(tokens)) {
                            output_size += token_id.length;
                            output_size += quantity.length;
                        }
                    }
                }
                if (output_size > max_utxo) {
                    console.log("This UTxO is too damn big!", output_size, max_utxo);
                }
                txn_size -= output_size;
            }

            return txn_size;
        },
        makeOutput(output_tokens) {
            const MultiAsset = CSL.MultiAsset.new();
            for (const token of output_tokens) {
                const ScriptHash = CSL.ScriptHash.from_hex(token.policy_id);
                const AssetName = CSL.AssetName.new(this.fromHex(token.token_id));
                const AssetQuantity = CSL.BigNum.from_str(token.quantity.toString());
                MultiAsset.set_asset(
                    ScriptHash,
                    AssetName,
                    AssetQuantity
                );
            }
            return CSL.TransactionOutputBuilder
                .new()
                .with_address(this.changeAddress)
                .next()
                .with_asset_and_min_required_coin_by_utxo_cost(
                    MultiAsset,
                    CSL.DataCost.new_coins_per_byte(
                        CSL.BigNum.from_str('4310')
                    )
                ).build();
        },
        packIn(tokens, outputs, skip_limits) {
            if (outputs === undefined) {
                outputs = [];
            }
            const repack = [];
            const output_tokens = [];
            let bundled = 0;
            let mixed_bundle = false;
            let full_bundle_size = this.settings.bundleSize;
            let mixed_bundle_size;

            if (skip_limits === true) {
                mixed_bundle_size = full_bundle_size;
            } else {
                mixed_bundle_size = Math.max(1, Math.floor(full_bundle_size / 2));
            }

            for (const policy of tokens) {
                const carry_tokens = [];

                if (bundled > 0) {
                    mixed_bundle = true;
                }

                if (bundled > 0 && policy.tokens.length + bundled > mixed_bundle_size) {
                    repack.push(policy);
                    continue;
                }

                for (const token of policy.tokens) {
                    if (mixed_bundle) {
                        if (bundled >= mixed_bundle_size) {
                            carry_tokens.push(token);
                            continue;
                        }

                        output_tokens.push(token);
                        bundled++;
                    } else {
                        if (bundled >= full_bundle_size) {
                            carry_tokens.push(token);
                            continue;
                        }

                        output_tokens.push(token);
                        bundled++;
                    }
                }

                if (carry_tokens.length) {
                    repack.push({
                        policy_id: policy.policy_id,
                        tokens: carry_tokens
                    });
                }
            }

            if (output_tokens.length) {
                outputs.push(output_tokens);
            }

            if (repack.length) {
                return this.packIn(repack, outputs, skip_limits);
            }

            return outputs;
        },
        process(token_type, tokens) {
            let ideal_outputs = [];
            switch (token_type) {
                case 'fungible':
                    if (this.settings.isolateFungible) {
                        for (const policy of tokens) {
                            const policy_outputs = this.packIn([policy]);
                            for (const output of policy_outputs) {
                                ideal_outputs.push(output);
                            }
                        }
                    } else {
                        ideal_outputs = this.packIn(tokens);
                    }
                    break;
                case 'nonfungible':
                    if (this.settings.isolateNonfungible) {
                        for (const policy of tokens) {
                            const policy_outputs = this.packIn([policy]);
                            for (const output of policy_outputs) {
                                ideal_outputs.push(output);
                            }
                        }
                    } else {
                        ideal_outputs = this.packIn(tokens);
                    }
                    break;
                default:
                    throw Error("Unknown token type!");
            }
            return ideal_outputs;
        }
    },
    async mounted() {
        const localSettings = JSON.parse(localStorage.getItem('UnFrackItSettings'));
        if (localSettings !== null) {
            this.settings = localSettings;
        } else {
            this.settings = JSON.parse(JSON.stringify(default_settings));
        }
        await this.checkForCardano();
    },
    watch: {
        settings: {
            async handler(newSettings) {
                this.watchSettings(newSettings);
            },
            deep: true
        }
    },
    created() {
        this.watchSettings = debounce((newSettings) => {
            if (newSettings === null) {
                return;
            }
            localStorage.setItem('UnFrackItSettings', JSON.stringify(newSettings));
            if (this.cardano.status === 'connected') {
                this.checkWalletBalance();
            }
        }, 500);

        this.watchingTx = setInterval(async () => {
            if (this.pendingTx !== null) {
                try {
                    const response = await axios.post(
                        `https://api.koios.rest/api/v0/tx_status`,
                        {
                            "_tx_hashes": [this.pendingTx]
                        }
                    );

                    if (response.status === 200) {
                        const data = response.data;
                        if (data[0].num_confirmations >= 10) {
                            console.log(`Have ${data[0].num_confirmations} confirmations of the transaction!`);
                            this.pendingTx = null;
                            await this.checkWalletBalance();
                        }
                    }
                } catch (e) {
                    console.error("Axios Error:", e);
                }
            }
        }, 15000);
    }
};
</script>

<style>
.swal2-container {
    font-family: roboto-regular, sans-serif;
}
</style>