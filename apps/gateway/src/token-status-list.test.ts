/** The Token Status List encoding against draft-ietf-oauth-status-list's own examples (§4.1), byte for byte. */
import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { TokenStatusList } from "./token-status-list.js";

const ONE_BIT = [1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0, 1];
const TWO_BIT = [1, 2, 0, 3, 0, 1, 0, 1, 1, 2, 3, 3];

describe("Token Status List encoding", () => {
  it("encodes the draft's 1-bit and 2-bit examples exactly", () => {
    const one = TokenStatusList.empty(ONE_BIT.length, 1);
    ONE_BIT.forEach((v, i) => one.set(i, v));
    expect(one.encode()).toBe("eNrbuRgAAhcBXQ");
    const two = TokenStatusList.empty(TWO_BIT.length, 2);
    TWO_BIT.forEach((v, i) => two.set(i, v));
    expect(two.encode()).toBe("eNo76fITAAPfAgc");
  });

  it("decodes them back, entry by entry", () => {
    const two = TokenStatusList.decode("eNo76fITAAPfAgc", 2);
    expect(two.size).toBe(12);
    expect(TWO_BIT.map((_, i) => two.get(i))).toEqual(TWO_BIT);
    const one = TokenStatusList.decode("eNrbuRgAAhcBXQ", 1);
    expect(ONE_BIT.map((_, i) => one.get(i))).toEqual(ONE_BIT);
  });

  it("sets one entry without touching its neighbours, and refuses what does not fit", () => {
    const l = TokenStatusList.empty(8, 2);
    l.set(3, 3);
    l.set(3, 1);
    expect([0, 1, 2, 3, 4].map((i) => l.get(i))).toEqual([0, 0, 0, 1, 0]);
    expect(() => l.set(0, 4)).toThrow(RangeError);
    expect(() => l.get(8)).toThrow(RangeError);
    expect(() => l.get(-1)).toThrow(RangeError);
    expect(() => TokenStatusList.empty(8, 3 as 2)).toThrow(RangeError);
  });

  it("refuses a malformed list and a decompression bomb", () => {
    expect(() => TokenStatusList.decode("not base64url!", 1)).toThrow();
    expect(() => TokenStatusList.decode("AAAA", 1)).toThrow();
    const bomb = deflateSync(Buffer.alloc(5 * 1024 * 1024)).toString("base64url");
    expect(() => TokenStatusList.decode(bomb, 1)).toThrow();
  });
});
