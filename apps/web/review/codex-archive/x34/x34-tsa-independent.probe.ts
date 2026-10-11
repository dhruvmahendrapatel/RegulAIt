/** X34 independent fragment: append to temporary gateway copy of
 * audit-timestamp-verify.test.ts. Real independent OpenSSL authority and
 * actual cryptographic signing helpers from that file, never a fake verifier. */
describe("X34 independent timestamp tamper controls", () => {
  it("a syntactically permitted RSA-PSS form with a forged signature still refuses", async () => {
    const valid = await signedWith("1.2.840.113549.1.1.10", pssParams("sha256", "sha256", 32), pss("sha256", 32));
    expect((await verifyTimestampResponse(valid, facts)).imprint).toMatch(/^[0-9a-f]{64}$/);
    const parsed = new TimeStampResp({ schema: derSchema(valid) });
    const cms = new SignedData({ schema: parsed.timeStampToken!.content });
    const signature = cms.signerInfos[0]!.signature.valueBlock.valueHexView;
    signature[0] = signature[0]! ^ 1;
    parsed.timeStampToken!.content = cms.toSchema(true);
    await expect(verifyTimestampResponse(Buffer.from(parsed.toSchema().toBER(false)), facts)).rejects.toThrow(/timestamp_signature/);
  });
  it("an intact signed response cannot substitute request bytes or nonce", async () => {
    await expect(verifyTimestampResponse(response, { ...facts, bytes: Buffer.from("synthetic other anchor") })).rejects.toThrow("timestamp_imprint_mismatch");
    await expect(verifyTimestampResponse(response, { ...facts, nonceHex: "00" })).rejects.toThrow("timestamp_nonce_mismatch");
  });
  it("a valid SHA-2 response fails verification without a trust root", async () => {
    await expect(verifyTimestampResponse(await signedWith("1.2.840.113549.1.1.11", new asn1.Null(), rsa("sha256")), { ...facts, trust: [] })).rejects.toThrow(/timestamp_signature/);
  });
  it("a valid response cannot substitute its embedded root for an unrelated configured root", async () => {
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2", "-subj", "/CN=RegulAIt Synthetic Unrelated Root", "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", file("unrelated.key"), "-out", file("unrelated.pem"));
    const unrelated = parseTimestampTrustBundle(readFileSync(file("unrelated.pem"), "utf8"));
    expect(unrelated).toHaveLength(1);
    await expect(verifyTimestampResponse(response, { ...facts, trust: unrelated })).rejects.toThrow(/timestamp_signature/);
  });
});
