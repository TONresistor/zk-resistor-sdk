// Error codes mirror contracts/errors.tolk; the contract throws them as TVM
// exit codes. Gaps in the sequence are intentional.

export const Errors = {
  InvalidMessage: 0xffff,
  JettonWalletAlreadySet: 103,
  JettonWalletNotSet: 104,
  NotJettonMaster: 105,
  InvalidAmount: 111,
  CommitmentAlreadyExists: 113,
  TreeFull: 114,
  InvalidInsertProof: 115,
  InsufficientDepositValue: 116,
  InsufficientGas: 120,
  UnknownRoot: 121,
  NullifierAlreadySpent: 122,
  InvalidWithdrawProof: 124,
  InsufficientReserve: 127,
  InsufficientBalance: 128,
  InvalidRecipient: 130,
  PoolAlreadyExists: 200,
  InvalidDenomination: 202,
  InsufficientCreatePoolFee: 203,
} as const;

export type ErrorName = keyof typeof Errors;
export type ErrorCode = (typeof Errors)[ErrorName];

const CODE_TO_NAME: ReadonlyMap<number, ErrorName> = new Map(
  (Object.entries(Errors) as [ErrorName, ErrorCode][]).map(([name, code]) => [
    code,
    name,
  ]),
);

export function errorName(code: number): ErrorName | undefined {
  return CODE_TO_NAME.get(code);
}
