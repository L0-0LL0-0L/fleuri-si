// Synthetic identities and terms for tests only. Never imported by application routes.
import { Keypair } from "@solana/web3.js";
import { domainHash } from "./canonical";
import { pqKeyHash, type PqKeypair } from "./mldsa";
import { DBC_PROGRAM_ID, PASSPORT_SCHEMA, SOL_MINT, type PassportManifest } from "./passport";
import { GENESIS } from "./registration";
export function manifestFixture(kp:PqKeypair):PassportManifest {
  const addr=()=>Keypair.generate().publicKey.toBase58();
  const snapshot={fixedTokenSupplyFlag:1,migrationOption:1};
  return {
    schema:PASSPORT_SCHEMA,domain:"https://fleuri.test",cluster:"devnet",genesisHash:GENESIS.devnet,dbcProgram:DBC_PROGRAM_ID,
    creatorWallet:addr(),identity:{alg:"ML-DSA-65",keyHash:pqKeyHash(kp.publicKey),registrationHash:"b".repeat(64),anchorSignature:"2".repeat(88)},launchNonce:"a".repeat(32),
    token:{baseMint:addr(),name:"Strange Bloom",symbol:"BLOOM",imageUri:"ipfs://"+"b".repeat(59),imageSha256:null,decimals:9,totalSupply:"1000000000000000000"},
    quote:{mint:SOL_MINT,symbol:"SOL"},config:{address:addr(),snapshot,snapshotHash:domainHash("fleuri:config-snapshot:v1",snapshot)},pool:{address:addr()},
    fees:{baseFeeBps:100,dynamicFeeEnabled:false,feeClaimer:addr(),creatorTradingFeePercent:20,partnerTradingFeePercent:80,poolCreationFeeLamports:"0"},
    lp:{creatorLiquidityPercent:0,creatorPermanentLockedPercent:20,partnerLiquidityPercent:0,partnerPermanentLockedPercent:80},
    migration:{target:"DAMM_V2",quoteThresholdLamports:"10000000000",migrationFeeOption:2,migrationFeePercent:5,creatorMigrationFeePercent:20,migratedPoolFeeBps:100},
    authority:{tokenUpdateAuthority:"immutable",mintAuthority:"revoked",freezeAuthority:"revoked",leftoverReceiver:addr(),policy:"SPL authorities revoked; metadata immutable."},devBuy:{enabled:false},
  };
}
