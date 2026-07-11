// A TVM stack entry: a decimal-string number, or a base64-encoded Cell BOC.
export type StackEntry = string | null;

export interface AccountState {
  status: string;
  // `data` and `code` are base64-encoded Cell BOCs, absent when uninitialized.
  data?: string;
  code?: string;
  balance?: string;
}

export interface RunMethodResult {
  exit_code: number;
  stack: StackEntry[];
}

export interface TransactionCursor {
  /** Logical time as a canonical unsigned decimal string. */
  lt: string;
  /** Canonical padded base64 encoding of the 32-byte transaction hash. */
  hash: string;
}

export interface RawTx {
  /** Canonical unsigned decimal LT. Required for deterministic replay. */
  lt: string;
  /** Canonical padded base64 encoding of the 32-byte transaction hash. */
  hash: string;
  /** Master/shard block seqno containing this transaction. */
  block_seqno: number;
  /** True only when the account transaction committed successfully. */
  success: boolean;
  in_msg?: {
    body?: string;
    source?: string;
    bounced?: boolean;
  };
  out_msgs?: RawOutMessage[];
}

export interface RawOutMessage {
  /** Base64-encoded message body BOC, when the RPC exposes it. */
  body?: string;
  /** Stable zero-based action/message index within the transaction. */
  index?: number;
  /** True only for an external-out message emitted as a contract log. */
  isExternal: boolean;
}

export interface GetTransactionsResult {
  transactions: RawTx[];
  /** True while older pages remain; false only at complete account history. */
  incomplete?: boolean;
}

// A getter argument: a decimal-string number, or a slice as a base64 Cell BOC.
export type RunMethodArg = string | { type: "slice"; boc: string };

export interface Client {
  getAccountState(address: string): Promise<AccountState>;
  runMethod(
    address: string,
    method: string,
    params: readonly RunMethodArg[],
  ): Promise<RunMethodResult>;
  getTransactions(
    address: string,
    limit: number,
    /** Exclusive transaction cursor; omit for the newest page. */
    before: TransactionCursor | undefined,
  ): Promise<GetTransactionsResult>;
}
