// Protocol constants, mirrored from contracts/constants.tolk. The SDK hardcodes
// no contract address: the factory address is always passed by the caller.

export const TREE_DEPTH = 20;
export const TREE_CAPACITY = 1 << TREE_DEPTH;
export const ROOT_HISTORY_SIZE = 100;

// Poseidon BLS12-381 zeros[20]: the depth-20 empty-tree root.
export const EMPTY_TREE_ROOT =
  0x276b3bddf0aaccd173fcb1b7d167d34d10680f45f6ed6363ab7ce2096874e0b3n;

export const POOL_TON_RESERVE = 50_000_000n; // 0.05 TON
export const FACTORY_TON_RESERVE = 100_000_000n; // 0.10 TON
export const RELAYER_REIMBURSEMENT = 300_000_000n; // 0.30 TON
export const MIN_DEPOSIT_VALUE = 320_000_000n; // 0.32 TON
export const MIN_WITHDRAW_GAS = 100_000_000n; // 0.10 TON
export const MIN_CREATE_POOL_FEE = 200_000_000n; // 0.20 TON
export const JETTON_TRANSFER_GAS = 50_000_000n; // 0.05 TON

export const TON_POOL_DENOMINATIONS = [
  10_000_000_000n, // 10 TON
  100_000_000_000n, // 100 TON
  1_000_000_000_000n, // 1000 TON
  10_000_000_000_000n, // 10000 TON
] as const;

// Lower 248 bits of an address hash; fits inside the BLS12-381 Fr field.
export const ADDRESS_FIELD_MASK: bigint = (1n << 248n) - 1n;

export const OP_JETTON_TRANSFER = 0x0f8a7ea5;
export const OP_JETTON_TRANSFER_NOTIFICATION = 0x7362d09c;
export const OP_PROVIDE_WALLET_ADDRESS = 0x2c76b973;
export const OP_TAKE_WALLET_ADDRESS = 0xd1735400;
export const OP_DEPOSIT = 0xd6e05111;
export const OP_WITHDRAW = 0x4b6f0b50;
export const OP_INIT_WALLET_BINDING = 0xa0c0c0c1;
export const OP_CREATE_POOL = 0xa0c0c0c0;
export const OP_CREATE_TON_POOL = 0xa0c0c0c2;

// Event topics use 24-bit prefixes: a parser must read 24 bits, not 32.
export const EVENT_POOL_READY = 0xdef002;
export const EVENT_DEPOSIT = 0xde9051;
export const EVENT_DEPOSIT_REFUNDED = 0xdef000;
export const EVENT_WITHDRAW = 0x717d3a;
export const EVENT_WITHDRAW_BOUNCED = 0xdef001;
export const EVENT_FACTORY_POOL_CREATED = 0xc0c0c0;
