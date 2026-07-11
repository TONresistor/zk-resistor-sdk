import { describe, it, expect } from "vitest";
import { Errors, errorName } from "../src/errors.js";

describe("Errors", () => {
  it("mirrors the contract enum codes", () => {
    expect(Errors.InvalidMessage).toBe(0xffff);
    expect(Errors.JettonWalletAlreadySet).toBe(103);
    expect(Errors.JettonWalletNotSet).toBe(104);
    expect(Errors.InvalidInsertProof).toBe(115);
    expect(Errors.InsufficientDepositValue).toBe(116);
    expect(Errors.InvalidDepositPayload).toBe(117);
    expect(Errors.NullifierAlreadySpent).toBe(122);
    expect(Errors.InsufficientBalance).toBe(128);
    expect(Errors.InvalidRecipient).toBe(130);
    expect(Errors.StaleSparseSetRoot).toBe(133);
    expect(Errors.InvalidSparseSetProof).toBe(134);
    expect(Errors.WithdrawalCapacityReached).toBe(135);
    expect(Errors.PoolAlreadyExists).toBe(200);
    expect(Errors.InsufficientCreatePoolFee).toBe(203);
    expect(Errors.FactoryCapacityReached).toBe(204);
    expect(Errors.TooManyInFlightCreates).toBe(205);
  });

  it("errorName resolves known codes and rejects unknown ones", () => {
    expect(errorName(122)).toBe("NullifierAlreadySpent");
    expect(errorName(129)).toBeUndefined();
    expect(errorName(131)).toBeUndefined();
    expect(errorName(203)).toBe("InsufficientCreatePoolFee");
    expect(errorName(0xffff)).toBe("InvalidMessage");
    expect(errorName(9)).toBeUndefined();
    expect(errorName(0)).toBeUndefined();
  });
});
