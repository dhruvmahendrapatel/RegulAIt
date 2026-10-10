/**
 * ADR-0186 decision 31 (B4I-02): the deterministic corpus the scrub equivalence and RE2 differential tests share.
 * Synthetic material only. Changing anything here changes the pinned snapshot in
 * `scrub-equivalence.snapshot.json`, which was produced by the implementation on main before decision 31; never
 * regenerate it from the code under test.
 */

/** the 400k-class dense inputs the budget tests use */
export const DENSE_INPUTS: Readonly<Record<string, string>> = {
  gate: "sk gl m n secret mysql: redis postgres mongodb xox sig= key- tok_ dapi hf_ r8_ ".repeat(5300),
  slack: `xoxb-${"a".repeat(12)}.`.repeat(22_223).slice(0, 400_000),
  google: "AIza-".repeat(80_000),
  eAcute: "é".repeat(400_000),
  longS: "x".repeat(400_000) + "ſ",
  kelvin: "a".repeat(400_000) + "K",
  openGates: "é".repeat(400_000) + " sk-ant- sk-proj- sk-svcacct- fw_ sk-or-v1- pplx- tvly- aiza gocspx- sk_live_ ghp_ glpat- discord vercel_ xprv 0x ",
};

const TOKENS = [
  `sk-ant-${"A".repeat(22)}`, `sk-ant-${"B".repeat(30)}`, `ghp_${"A1b2C3d4E5f6".repeat(3)}`, `ghp_${"a".repeat(36)}`, "AKIAIOSFODNN7EXAMPLE",
  `rgl_${"a1b2c3d4".repeat(6)}`, `AIza${"A".repeat(35)}`, `AIza${"x-_9".repeat(9)}Q`, `xoxb-${"1".repeat(15)}`, `xoxp-${"a1".repeat(10)}`,
  `glpat-${"x".repeat(20)}`, "postgres://user:pass@db.example.test", "postgresql://u:p@h", "mysql://root:hunter2@h", "redis://:pw@h",
  "mongodb+srv://a:b@c", `SK${"a".repeat(32)}`, `key-${"a".repeat(32)}`, `hf_${"A".repeat(34)}`, `r8_${"a".repeat(40)}`, `tok_${"a".repeat(40)}`,
  `dapi${"a".repeat(32)}`, `0x${"a".repeat(64)}`, "123-45-6789", `xprv${"9".repeat(107)}`, `sig=${"A".repeat(43)}=`, `sig=${"a".repeat(43)}%3d`,
  `fw_${"A".repeat(24)}`, `sk_live_${"a".repeat(24)}`, `SG.${"a".repeat(22)}.${"b".repeat(43)}`, `vercel_${"a".repeat(24)}`,
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  `M${"a".repeat(23)}.${"b".repeat(6)}.${"c".repeat(27)}`, `123456-${"a".repeat(32)}.apps.googleusercontent.com`,
  `API_SECRET_KEY=${"x".repeat(12)}`, `aws_secret_access_key: ${"A".repeat(40)}`, "secret access key='" + "A".repeat(40) + "'",
  "-----BEGIN RSA PRIVATE KEY-----", "password=hunter2-synthetic", "TOKEN=abcdefgh12345678", `ſk-ant-${"A".repeat(22)}`, "ﬁ",
];
const FRAGMENTS = [
  "sk-ant-", "sk-", "AIza", "xoxb-", "xoxp-", "ghp_", "gho_", "glpat-", "postgres://", "postgresql://", "mysql://", "redis://", "mongodb+srv://",
  "@", ":", "=", "'", "\"", " ", "  ", "\n", "\t", "-", "_", ".", "/", "+", "%3d", "sig=", "key-", "SK", "sk", "0x", "xprv", "eyJ", "ey",
  ".apps.googleusercontent.com", "AKIA", "aws_secret_access_key", "SECRET_KEY", "PASSWORD", "TOKEN", "hf_", "r8_", "tok_", "dapi", "fw_",
  "ſ", "K", "İ", "é", "😀", "\ud800", "\udc00", "[redacted:", "]", "0123456789", "abcdef", "ABCDEF", "a".repeat(20), "A".repeat(36),
  "Z9".repeat(12), "M", "N", "api_key=", "secret='", "Bearer ",
];
const forgedShapes = (t: string): string[] => [
  `[redacted:${t}:40:012345abcdef]`, `[redacted:field+${t}:40:012345abcdef]`, `[redacted:aws_key+${t}:40:012345abcdef]`,
  `[redacted:field:${t}:012345abcdef]`, `[redacted:field:40:${t}]`, `[redacted:field:40:012345abcdef-${t}]`,
  `[redacted:field:40:012345abcdef]${t}`, `${t}[redacted:field:40:012345abcdef]`,
  `[redacted:field:40:012345abcdef][redacted:${t}:1:aaaaaaaaaaaa]`, `[redacted:[redacted:field:40:012345abcdef]${t}:40:012345abcdef]`,
  `[redacted:field:40:012345abcdef ${t}]`,
];

/** xorshift32, so the corpus is identical on every run and in the snapshot generator */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
}

/** groups of inputs; the snapshot pins one digest per group */
export function scrubEquivalenceCorpus(): Array<{ group: string; inputs: string[] }> {
  const groups: Array<{ group: string; inputs: string[] }> = [];
  groups.push({ group: "dense", inputs: Object.values(DENSE_INPUTS) });
  groups.push({ group: "forged", inputs: TOKENS.flatMap(forgedShapes) });
  groups.push({ group: "tokens", inputs: TOKENS.flatMap((t) => [t, ` ${t} `, `x${t}`, `${t}x`, `"${t}"`, `${t}${t}`, t.toUpperCase(), t.toLowerCase()]) });
  const next = prng(0x0b41_0202);
  for (let g = 0; g < 40; g++) {
    const inputs: string[] = [];
    for (let i = 0; i < 100; i++) {
      const parts = 1 + (next() % 24);
      inputs.push(Array.from({ length: parts }, () => {
        const pick = next() % 5 === 0 ? TOKENS[next() % TOKENS.length]! : FRAGMENTS[next() % FRAGMENTS.length]!;
        return next() % 4 === 0 ? pick.repeat(1 + (next() % 4)) : pick;
      }).join(""));
    }
    groups.push({ group: `random-${g}`, inputs });
  }
  // longer mixed texts: tokens inside prose-sized runs, near-misses with one character changed
  const mixed: string[] = [];
  for (let i = 0; i < 200; i++) {
    const token = TOKENS[next() % TOKENS.length]!;
    const at = next() % token.length;
    const nearMiss = token.slice(0, at) + FRAGMENTS[next() % FRAGMENTS.length]! + token.slice(at + 1);
    mixed.push(`${"lorem ipsum ".repeat(next() % 50)}${token} ${nearMiss} ${"é".repeat(next() % 30)}${token}`);
  }
  groups.push({ group: "mixed", inputs: mixed });
  return groups;
}
