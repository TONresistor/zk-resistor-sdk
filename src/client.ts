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

export interface RawTx {
  out_msgs?: { body?: string }[];
}

export interface GetTransactionsResult {
  transactions: RawTx[];
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
  getTransactions(address: string, limit: number): Promise<GetTransactionsResult>;
}
