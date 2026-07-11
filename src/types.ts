export interface BasePool {
  poolAddress: string;
  denomination: bigint;
  nextIndex: number;
  capacity: number;
  currentRoot: bigint;
}

export interface JettonPoolInfo extends BasePool {
  kind: "jetton";
  jettonMaster: string;
  jettonSymbol: string;
  jettonDecimals: number;
  jettonImage: string | null;
  jettonName: string | null;
  jettonWallet: string | null;
}

export interface TonPoolInfo extends BasePool {
  kind: "ton";
  pendingWithdrawTon: bigint;
}

export type PoolInfo = JettonPoolInfo | TonPoolInfo;

export interface JettonPoolState {
  currentRoot: bigint;
  nextIndex: number;
  denomination: bigint;
  jettonWallet: string | null;
  relayerReserve: bigint;
  withdrawalCount: number;
}

export interface TonPoolState {
  currentRoot: bigint;
  nextIndex: number;
  denomination: bigint;
  pendingWithdrawTon: bigint;
  relayerReserve: bigint;
}

export interface Note {
  asset: string;
  denominationUnits: bigint;
  leafIndex: number;
  nullifier: bigint;
  secret: bigint;
  /** Binds the secrets to the pool in which the commitment was inserted. */
  poolAddress: string;
  poolKind: "jetton" | "ton";
}

export interface PoolReadyEvent {
  jettonWallet: string;
}

export interface FactoryPoolCreatedEvent {
  jettonMaster: string | null;
  denomination: bigint;
  poolAddress: string;
}

export interface MerklePath {
  pathElements: bigint[];
  pathIndices: number[];
}

export interface InsertWitness {
  oldRoot: string;
  newRoot: string;
  commitment: string;
  leafIndex: string;
  pathElements: string[];
  zeros: string[];
}

export interface WithdrawWitness {
  root: string;
  nullifierHash: string;
  recipient: string;
  nullifier: string;
  secret: string;
  pathElements: string[];
  pathIndices: string[];
}

export interface DepositEvent {
  leafIndex: number;
  commitment: bigint;
  newRoot: bigint;
  fromUser: string;
  sparseUpdate: SparseSetEventUpdate;
}

export interface SparseSetEventUpdate {
  bucketId: number;
  newRoot: bigint;
}

export interface TonWithdrawEvent {
  kind: "ton-withdraw";
  nullifierHash: bigint;
  recipient: string;
  payout: bigint;
  sparseUpdate: SparseSetEventUpdate;
}

export interface JettonWithdrawalAcceptedEvent {
  kind: "jetton-withdraw";
  clientQueryId: bigint;
  nullifierHash: bigint;
  recipient: string;
  payout: bigint;
  sparseUpdate: SparseSetEventUpdate;
}

export interface Groth16Proof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: string;
  curve: string;
}
