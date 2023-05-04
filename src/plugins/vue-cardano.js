import { Buffer } from "buffer";
import * as CSL from "../lib/CardanoSerializationLib.js";
import axios from "axios";

const defaultOptions = {
  retries: 10,
  frequency: 200,
};

const Koios = {
  defaultParameters: {
    linearFee: {
      minFeeA: "44",
      minFeeB: "155381",
    },
    minUtxo: "1000000",
    poolDeposit: "500000000",
    keyDeposit: "2000000",
    maxValSize: 5000,
    maxTxSize: 16384,
    costPerWord: "4310",
  },
  async getTip() {
    let response;
    try {
      response = await axios.get("https://api.koios.rest/api/v0/tip");
    } catch (e) {
      console.error("Could not query blockchain tip from Koios:", e);
      return false;
    }

    return response.data[0];
  },
  async getParameters(epoch) {
    if (epoch === undefined) {
      const tip = await this.getTip();
      if (!tip) {
        console.log(
          "Could not fetch tip from Koios. Returning default parameters."
        );
        return this.defaultParameters;
      }
      epoch = tip.epoch_no;
    }

    let response;
    try {
      response = await axios.get(
        "https://api.koios.rest/api/v0/epoch_params?_epoch_no=" + epoch
      );
    } catch (e) {
      console.log(
        "Could not fetch parameters from Koios. Returning default parameters."
      );
      return this.defaultParameters;
    }

    const params = response.data[0];

    if (!params.min_fee_a) {
      return this.defaultParameters;
    }

    return {
      linearFee: {
        minFeeA: params.min_fee_a,
        minFeeB: params.min_fee_b,
      },
      minUtxo: params.min_utxo_value,
      poolDeposit: params.pool_deposit,
      keyDeposit: params.key_deposit,
      maxValSize: params.max_val_size,
      maxTxSize: params.max_tx_size,
      costPerWord: params.coins_per_utxo_size,
    };
  },
};

export default {
  install(Vue, options) {
    let userOptions = { ...defaultOptions, ...options };

    Vue.mixin({
      data() {
        return {
          cardano: {
            status: "init",
            retries: userOptions.retries,
            pollingFrequency: userOptions.frequency,
            found: false,
            SupportedWallets: [
              "nami",
              "eternl",
              "flint",
              "typhoncip30",
              "gerowallet",
              "yoroi",
              "LodeWallet",
              "nufi",
              "vespr",
              "begin",
              "lace",
            ],
            Wallets: [],
            Wallet: null,
            ActiveWallet: false,
            stake_key: null,
            change_address: null,
            protocol_parameters: null,
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
        checkForCardano() {
          let loop = setInterval(async () => {
            if (this.cardano.retries <= 0) {
              if (this.cardano.found) {
                this.cardano.status = "found";
              } else {
                this.cardano.status = "notfound";
              }
              clearInterval(loop);
              await this.getParameters();
              return;
            }

            if (window.cardano !== undefined) {
              this.cardano.found = true;
              this.checkWallets();
            }

            this.cardano.retries--;
          }, this.cardano.pollingFrequency);
        },
        checkWallets() {
          if (window.cardano === undefined) {
            return;
          }

          this.cardano.SupportedWallets.forEach((name) => {
            if (window.cardano[name] === undefined) {
              return;
            }

            if (
              window.cardano[name].experimental &&
              window.cardano[name].experimental.vespr_compat === true
            ) {
              return;
            }

            if (window.cardano[name].name.includes("via VESPR")) {
              return;
            }

            const wallet = window.cardano[name];
            if (!this.cardano.Wallets.includes(wallet)) {
              this.cardano.Wallets.push(wallet);
            }
          });
        },
        async connect(wallet) {
          wallet.loading = true;
          try {
            this.cardano.ActiveWallet = wallet;
            this.cardano.Wallet = await wallet.enable();
            this.cardano.status = "connected";
            await this.getChangeAddress();
            this.cardano.stake_key = await this.getStakeKey();
            this.$emit("connected");
            wallet.loading = false;
          } catch (e) {
            wallet.loading = false;
            console.error("Connection Error:", e);
            throw e;
          }
        },
        async getWalletNetwork() {
          return await this.cardano.Wallet.getNetworkId();
        },
        async checkNetwork(network_id) {
          const wallet_network = await this.cardano.Wallet.getNetworkId();
          console.log(
            `Wallet Network ID: ${wallet_network}`,
            typeof wallet_network
          );
          return wallet_network === network_id;
        },
        changeWallet() {
          this.cardano.ActiveWallet = false;
          this.cardano.Wallet = null;
          this.cardano.status = "found";
          this.cardano.stake_key = null;
          this.cardano.change_address = null;
        },
        async getChangeAddress() {
          try {
            const usedAddresses = await this.cardano.Wallet.getUsedAddresses();
            const addressHex = this.fromHex(usedAddresses[0]);
            if (!addressHex) {
              return false;
            }
            return CSL.Address.from_bytes(addressHex);
          } catch (e) {
            console.log("Change Address Error:", e);
            return false;
          }
        },
        async checkBalance(asset) {
          try {
            const balance = CSL.Value.from_hex(
              await this.cardano.Wallet.getBalance()
            );

            if (asset) {
              const policy = CSL.ScriptHash.from_bytes(
                this.fromHex(asset.policy_id)
              );
              const asset_name = CSL.AssetName.new(
                this.fromHex(asset.asset_id)
              );
              if (balance.multiasset() === undefined) {
                return 0;
              } else {
                return balance
                  .multiasset()
                  .get_asset(policy, asset_name)
                  .to_str();
              }
            } else {
              return balance.coin().to_str();
            }
          } catch (e) {
            console.error("Get Balance Error:", e);
          }
        },
        async getTokens(policy_id) {
          try {
            const assets_held = [];

            const balance = CSL.Value.from_hex(
              await this.cardano.Wallet.getBalance()
            );

            if (balance.multiasset() === undefined) {
              return [];
            }

            const ScriptHash = CSL.ScriptHash.from_bytes(
              this.fromHex(policy_id)
            );

            const assets = balance.multiasset().get(ScriptHash);

            if (!assets || assets.len() === 0) {
              return [];
            }

            for (let i = 0; i < assets.keys().len(); i++) {
              const Asset = assets.keys().get(i);
              const AssetName = this.toAscii(Asset.name());
              const asset = {
                name: AssetName,
                policy_id: policy_id,
                asset_id: this.toHex(Asset.name()),
                assetId: policy_id + this.toHex(Asset.name()),
              };
              assets_held.push(asset);
            }

            return assets_held;
          } catch (e) {
            console.error("Get Tokens Error:", e);
          }
        },
        async getStakeCbor() {
          const rewardAddresses =
            await this.cardano.Wallet.getRewardAddresses();
          return rewardAddresses[0];
        },
        async getStakeKey() {
          const stakeAddressCbor = await this.getStakeCbor();
          const stakeAddress = CSL.Address.from_bytes(
            this.toUint8Array(stakeAddressCbor)
          );
          return stakeAddress.to_bech32();
        },
        async signData(payload) {
          const stakeAddressCbor = await this.getStakeCbor();
          return await this.cardano.Wallet.signData(stakeAddressCbor, payload);
        },
        async getParameters() {
          if (this.cardano.protocol_parameters === null) {
            this.cardano.protocol_parameters = await Koios.getParameters();
          }

          return this.cardano.protocol_parameters;
        },
        async getUTxO() {
          const UTxO = CSL.TransactionUnspentOutputs.new();
          const walletUTxO = await this.cardano.Wallet.getUtxos();
          walletUTxO.map((utxo) => {
            UTxO.add(
                CSL.TransactionUnspentOutput.from_bytes(this.fromHex(utxo))
            )
          });
          return UTxO;
        },
        async prepareTransaction() {
          const protocolParameters = await this.getParameters();
          const txBuilderConfig = CSL.TransactionBuilderConfigBuilder.new()
            .fee_algo(
              CSL.LinearFee.new(
                CSL.BigNum.from_str(
                  protocolParameters.linearFee.minFeeA.toString()
                ),
                CSL.BigNum.from_str(
                  protocolParameters.linearFee.minFeeB.toString()
                )
              )
            )
            .coins_per_utxo_byte(
              CSL.BigNum.from_str(protocolParameters.costPerWord.toString())
            )
            .pool_deposit(
              CSL.BigNum.from_str(protocolParameters.poolDeposit.toString())
            )
            .key_deposit(
              CSL.BigNum.from_str(protocolParameters.keyDeposit.toString())
            )
            .max_value_size(protocolParameters.maxValSize)
            .max_tx_size(protocolParameters.maxTxSize)
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
        async makeTransaction(recipients, metadata, ttl, dataHash) {
          const changeAddress = await this.getChangeAddress();

          const inputs = CSL.TransactionUnspentOutputs.new();
          (await this.cardano.Wallet.getUtxos()).map((utxo) =>
            inputs.add(
              CSL.TransactionUnspentOutput.from_bytes(this.fromHex(utxo))
            )
          );

          const txBuilder = await this.prepareTransaction();
          const protocolParameters = await this.getParameters();

          let minting = 0;
          let MintAssets = [];
          let MintingPolicies = [];

          recipients.forEach((recipient) => {
            console.log(recipient);

            const lovelace = recipient.lovelace;
            const ReceiveAddress = CSL.Address.from_bech32(recipient.address);

            let output;

            if (
              recipient.mintedAssets !== undefined &&
              recipient.mintedAssets.length
            ) {
              recipient.mintedAssets.forEach((asset) => {
                minting++;

                if (!MintingPolicies.includes(asset.policyScript)) {
                  MintingPolicies.push(asset.policyScript);
                }

                MintAssets.push(asset);
              });
              return;
            }

            if (recipient.assets !== undefined && recipient.assets.length > 0) {
              const multiasset = CSL.MultiAsset.new();
              recipient.assets.forEach((entry) => {
                const scriptHash = CSL.ScriptHash.from_hex(entry.policy);
                const assetName = CSL.AssetName.new(
                  this.fromAscii(entry.asset)
                );
                const quantity = CSL.BigNum.from_str(entry.quantity.toString());
                multiasset.set_asset(scriptHash, assetName, quantity);
              });
              if (lovelace > 0) {
                output = CSL.TransactionOutputBuilder.new()
                  .with_address(ReceiveAddress)
                  .next()
                  .with_coin_and_asset(
                    CSL.BigNum.from_str(lovelace.toString()),
                    multiasset
                  )
                  .build();
              } else {
                output = CSL.TransactionOutputBuilder.new()
                  .with_address(ReceiveAddress)
                  .next()
                  .with_asset_and_min_required_coin_by_utxo_cost(
                    multiasset,
                    CSL.DataCost.new_coins_per_byte(
                      CSL.BigNum.from_str(
                        protocolParameters.costPerWord.toString()
                      )
                    )
                  )
                  .build();
              }
            } else {
              output = CSL.TransactionOutputBuilder.new()
                .with_address(ReceiveAddress)
                .next()
                .with_coin(CSL.BigNum.from_str(lovelace.toString()))
                .build();
            }

            try {
              txBuilder.add_output(output);
            } catch (e) {
              console.error("Adding Output Error:", e);
            }
          });

          const NativeScripts = CSL.NativeScripts.new();

          if (minting) {
            let assetsDict = {};

            MintingPolicies.forEach((scriptHash) => {
              NativeScripts.add(
                CSL.NativeScript.from_bytes(this.fromHex(scriptHash))
              );
            });

            MintAssets.forEach((entry) => {
              if (assetsDict[entry.assetName] === undefined) {
                assetsDict[entry.assetName] = {
                  quantity: 0,
                  policyId: entry.policyId,
                  scriptHash: entry.policyScript,
                };
              }
              assetsDict[entry.assetName].quantity =
                assetsDict[entry.assetName].quantity + parseInt(entry.quantity);
            });

            Object.entries(assetsDict).map(([name, asset]) => {
              try {
                let assetQty;

                if (asset.quantity < 0) {
                  assetQty = CSL.Int.new_negative(
                    CSL.BigNum.from_str((asset.quantity * -1).toString())
                  );
                } else {
                  assetQty = CSL.Int.new(
                    CSL.BigNum.from_str(asset.quantity.toString())
                  );
                }

                txBuilder.add_mint_asset(
                  CSL.NativeScript.from_bytes(this.fromHex(asset.scriptHash)),
                  CSL.AssetName.new(Buffer.from(name)),
                  assetQty
                );
              } catch (e) {
                this.doError("Error attempting to add a new minted asset!");
                console.error(
                  "Error attempting to add a minted asset!",
                  e,
                  asset,
                  name
                );
              }
            });
          }

          if (metadata) {
            Object.entries(metadata).map(([MetadataLabel, Metadata]) => {
              txBuilder.add_json_metadatum(
                CSL.BigNum.from_str(MetadataLabel),
                JSON.stringify(Metadata)
              );
            });
          }

          if (ttl) {
            txBuilder.set_ttl(parseInt(ttl));
          }

          try {
            txBuilder.add_inputs_from(
              inputs,
              CSL.CoinSelectionStrategyCIP2.LargestFirstMultiAsset
            );
            (await txBuilder).add_change_if_needed(changeAddress);
          } catch (e) {
            console.error("Adding Inputs Error:", e);
            return;
          }

          let txBuilt;
          try {
            txBuilt = await txBuilder.build();
          } catch (e) {
            console.error("Building Transaction Error:", e);
            return;
          }

          if (dataHash) {
            const auxDataHash = CSL.AuxiliaryDataHash.from_bytes(
              this.fromHex(dataHash)
            );
            txBuilt.set_auxiliary_data_hash(auxDataHash);
          }

          const witnessSet = CSL.TransactionWitnessSet.new();

          if (minting) {
            witnessSet.set_native_scripts(NativeScripts);
          }

          const tx = CSL.Transaction.new(txBuilt, witnessSet);

          return this.toHex(tx.to_bytes());
        },
        async getCollateral() {
          const collateral = await this.cardano.Wallet.experimental.getCollateral();
          console.log(collateral);

        },
        async submitTransaction(tx, witnesses) {
          try {
            // const witnesses = CSL.TransactionWitnessSet.from_bytes(this.fromHex(witnesses));

            const transaction = CSL.Transaction.from_bytes(this.fromHex(tx));
            const txWitnesses = transaction.witness_set();
            const txVkeys = txWitnesses.vkeys();
            const txScripts = txWitnesses.native_scripts();
            const totalVkeys = CSL.Vkeywitnesses.new();
            const totalScripts = CSL.NativeScripts.new();

            for (let witness of witnesses) {
              const addWitnesses = CSL.TransactionWitnessSet.from_bytes(
                this.fromHex(witness)
              );
              const addVkeys = addWitnesses.vkeys();
              if (addVkeys) {
                for (let i = 0; i < addVkeys.len(); i++) {
                  totalVkeys.add(addVkeys.get(i));
                }
              }
            }

            if (txVkeys) {
              for (let i = 0; i < txVkeys.len(); i++) {
                totalVkeys.add(txVkeys.get(i));
              }
            }

            if (txScripts) {
              for (let i = 0; i < txScripts.len(); i++) {
                totalScripts.add(txScripts.get(i));
              }
            }

            const totalWitnesses = CSL.TransactionWitnessSet.new();
            totalWitnesses.set_vkeys(totalVkeys);
            totalWitnesses.set_native_scripts(totalScripts);

            const signedTx = await CSL.Transaction.new(
              transaction.body(),
              totalWitnesses
            );

            try {
              return await this.cardano.Wallet.submitTx(
                this.toHex(signedTx.to_bytes())
              );
            } catch (e) {
              console.log("Error Submitting Transaction:", e);
            }
          } catch (e) {
            console.error("Submit Transaction Error:", e);
          }
        },
        async signTransaction(hex) {
          try {
            const witnesses = await this.cardano.Wallet.signTx(hex, true);
            return {
              tx: hex,
              witnesses: witnesses,
            };
          } catch (e) {
            console.log("User declined to sign the transaction?", e);
            return false;
          }
        },
      },
    });
  },
};
