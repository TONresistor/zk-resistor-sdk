// Protocol constants, mirrored from contracts/constants.tolk. The SDK hardcodes
// no contract address: the factory address is always passed by the caller.

export const TREE_DEPTH = 20;
export const TREE_CAPACITY = 1 << TREE_DEPTH;
export const ROOT_HISTORY_SIZE = 100;

// BLS12-381 scalar field order. Contract verifier public inputs must be < r.
export const BLS12_381_R =
  0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;

// Poseidon BLS12-381 zeros[20]: the depth-20 empty-tree root.
export const EMPTY_TREE_ROOT =
  0x276b3bddf0aaccd173fcb1b7d167d34d10680f45f6ed6363ab7ce2096874e0b3n;

export const POOL_TON_RESERVE = 50_000_000n; // 0.05 TON
export const FACTORY_TON_RESERVE = 370_000_000n; // 0.37 TON
export const RELAYER_REIMBURSEMENT = 300_000_000n; // 0.30 TON
export const MIN_DEPOSIT_VALUE = 370_000_000n; // 0.37 TON
export const MIN_WITHDRAW_GAS = 100_000_000n; // 0.10 TON
export const MIN_JETTON_WITHDRAW_GAS = 250_000_000n; // 0.25 TON
export const MIN_CREATE_JETTON_POOL_FEE = 450_000_000n; // 0.45 TON
export const MIN_CREATE_TON_POOL_FEE = 450_000_000n; // 0.45 TON
// Covers the unbound Pool's 0.05 TON TEP-89 query and 0.01 TON handler budget.
export const MIN_INIT_WALLET_BINDING_VALUE = 60_000_000n; // 0.06 TON
// Bound Pools only need the 0.01 TON Factory confirmation and handler budget.
export const MIN_POOL_CONFIRMATION_VALUE = 20_000_000n; // 0.02 TON
export const JETTON_TRANSFER_GAS = 50_000_000n; // 0.05 TON

export const TON_POOL_DENOMINATIONS = [
  10_000_000_000n, // 10 TON
  100_000_000_000n, // 100 TON
  1_000_000_000_000n, // 1000 TON
  10_000_000_000_000n, // 10000 TON
] as const;

// Domain separator for the canonical full-recipient binding:
// Cell(domain:uint32, workchain:int32, accountHash:uint256).hash().
export const RECIPIENT_FIELD_DOMAIN = 0x5a4b5201;

// Lower 248 bits of the domain-separated recipient digest; fits inside the
// BLS12-381 Fr field.
export const ADDRESS_FIELD_MASK: bigint = (1n << 248n) - 1n;

// Exact executable-code hashes accepted by buildWithdraw. Legacy allowlists
// contain only deployments whose ABI, verifier, and recipient binding are known.
export const SECURE_POOL_CODE_HASH =
  "51cd5b3ec01beb28a843d30ecf60ea998d1107342a214969ae72047f1eb82dec";
export const SECURE_TON_POOL_CODE_HASH =
  "fde119db0060a01c0a00adc307ec98a2bf5b734ca7ef45e886c9ca2cce642aa3";
export const LEGACY_POOL_CODE_HASHES = Object.freeze([
  "caca8420450e7ae086462cdd7ce32fcbb1c5650151f1606003515b598bcc26db",
] as const);
export const LEGACY_TON_POOL_CODE_HASHES = Object.freeze([
  "057bf7a3006b61bdcc8b77b1264f3b473ff2fec0181de478059eb0d40ecd9d78",
] as const);

export const OP_JETTON_TRANSFER = 0x0f8a7ea5;
export const OP_JETTON_TRANSFER_NOTIFICATION = 0x7362d09c;
export const OP_PROVIDE_WALLET_ADDRESS = 0x2c76b973;
export const OP_TAKE_WALLET_ADDRESS = 0xd1735400;
export const OP_DEPOSIT = 0xd6e05112;
export const OP_WITHDRAW = 0x4b6f0b51;
export const OP_INIT_WALLET_BINDING = 0xa0c0c0c1;
export const OP_CREATE_POOL = 0xa0c0c0c0;
export const OP_CREATE_TON_POOL = 0xa0c0c0c2;

// Event bodies use the same 32-bit struct prefixes as the contracts. Some
// values start with 0x00, but parsers must still read the full 32 bits.
export const EVENT_POOL_READY = 0x00def002;
export const EVENT_DEPOSIT = 0x00de9052;
export const EVENT_TON_WITHDRAW = 0x00717d3b;
export const EVENT_WITHDRAW = 0x00717d3c;
export const EVENT_FACTORY_POOL_CREATED = 0x00c0c0c0;
