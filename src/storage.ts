import { Address, Cell } from "@ton/core";

const ADDR_FMT = { urlSafe: true, bounceable: true } as const;

const fmtAddr = (a: Address): string => a.toString(ADDR_FMT);

export interface JettonPoolStorage {
  jettonMaster: string;
  factory: string;
  denomination: bigint;
  jettonWallet: string | null;
  relayerReserve: bigint;
  nextIndex: number;
  currentRoot: bigint;
}

// Storage: refs [identity, merkle]; bits [jettonWallet:address?, relayerReserve:coins].
// identity: jettonMaster:address, factory:address, denomination:coins.
// merkle:   nextIndex:uint32, currentRoot:uint256, then three dicts (unread).
export function parseJettonPoolStorage(dataB64: string): JettonPoolStorage {
  const main = Cell.fromBase64(dataB64).beginParse();
  const identity = main.loadRef().beginParse();
  const merkle = main.loadRef().beginParse();
  const jettonWallet = main.loadMaybeAddress();
  const relayerReserve = main.loadCoins();
  const jettonMaster = identity.loadAddress();
  const factory = identity.loadAddress();
  const denomination = identity.loadCoins();
  const nextIndex = merkle.loadUint(32);
  const currentRoot = merkle.loadUintBig(256);
  return {
    jettonMaster: fmtAddr(jettonMaster),
    factory: fmtAddr(factory),
    denomination,
    jettonWallet:
      jettonWallet instanceof Address ? fmtAddr(jettonWallet) : null,
    relayerReserve,
    nextIndex,
    currentRoot,
  };
}

export interface TonPoolStorage {
  factory: string;
  denomination: bigint;
  relayerReserve: bigint;
  pendingWithdrawTon: bigint;
  nextIndex: number;
  currentRoot: bigint;
}

// TonPoolStorage: refs [identity, merkle];
// bits [relayerReserve:coins, pendingWithdrawTon:coins].
// identity: factory:address, denomination:coins.
// merkle:   nextIndex:uint32, currentRoot:uint256, then three dicts (unread).
export function parseTonPoolStorage(dataB64: string): TonPoolStorage {
  const main = Cell.fromBase64(dataB64).beginParse();
  const identity = main.loadRef().beginParse();
  const merkle = main.loadRef().beginParse();
  const relayerReserve = main.loadCoins();
  const pendingWithdrawTon = main.loadCoins();
  const factory = identity.loadAddress();
  const denomination = identity.loadCoins();
  const nextIndex = merkle.loadUint(32);
  const currentRoot = merkle.loadUintBig(256);
  return {
    factory: fmtAddr(factory),
    denomination,
    relayerReserve,
    pendingWithdrawTon,
    nextIndex,
    currentRoot,
  };
}
