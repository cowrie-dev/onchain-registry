import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addressMatchesMatching } from "../scripts/utils/createx.js";

describe("addressMatchesMatching", () => {
  const ADDR = "0xC0c0Ca7eEEEEEEEEEEEEEEEEEEEEEEEEEEEEcAfE" as const;
  const ALL_X = "X".repeat(40);

  it("an all-X pattern matches anything", () => {
    assert.equal(addressMatchesMatching(ADDR, ALL_X), true);
  });

  it("matches a prefix-shaped pattern", () => {
    const pattern = "c0c0" + "X".repeat(36);
    assert.equal(addressMatchesMatching(ADDR, pattern), true);
  });

  it("matches a suffix-shaped pattern", () => {
    const pattern = "X".repeat(36) + "cafe";
    assert.equal(addressMatchesMatching(ADDR, pattern), true);
  });

  it("matches a both-ends pattern", () => {
    const pattern = "c0c0" + "X".repeat(32) + "cafe";
    assert.equal(addressMatchesMatching(ADDR, pattern), true);
  });

  it("matches case-insensitively in both pattern and address body", () => {
    const pattern = "C0C0" + "x".repeat(32) + "CAFE";
    assert.equal(addressMatchesMatching(ADDR, pattern), true);
  });

  it("rejects when the prefix segment differs", () => {
    const pattern = "dead" + "X".repeat(32) + "cafe";
    assert.equal(addressMatchesMatching(ADDR, pattern), false);
  });

  it("rejects when the suffix segment differs", () => {
    const pattern = "c0c0" + "X".repeat(32) + "dead";
    assert.equal(addressMatchesMatching(ADDR, pattern), false);
  });

  it("rejects an interior char that doesn't match", () => {
    // Force a single non-X character in the middle to a value that differs
    // from the address body at that position.
    const body = ADDR.slice(2).toLowerCase();
    const wrong = body[20] === "0" ? "1" : "0";
    const pattern = "X".repeat(20) + wrong + "X".repeat(19);
    assert.equal(addressMatchesMatching(ADDR, pattern), false);
  });

  it("throws when pattern length is not 40", () => {
    assert.throws(() => addressMatchesMatching(ADDR, "c0c0"), /40/);
    assert.throws(() => addressMatchesMatching(ADDR, "X".repeat(41)), /40/);
  });

  it("throws on non-hex, non-X characters", () => {
    const pattern = "ghij" + "X".repeat(36);
    assert.throws(() => addressMatchesMatching(ADDR, pattern), /hex.*X/i);
  });
});
