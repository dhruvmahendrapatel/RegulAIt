/** X34 independent fragment: insert immediately before final `});` in a
 * temporary gateway copy of decision-receipts.test.ts. Uses the actual
 * migrated PostgreSQL, signing sweep, API and fixture keys; no mock signer. */
it("X34 classification metadata, rather than rule-name resemblance, gates signing", async () => {
  useKey("fixture-2", secondKey);
  const before = (await db.select().from(decisionReceipts)).length;
  const ids: string[] = [];
  for (const receiptClass of ["excluded", "configuration", "future-class", null]) {
    const [row] = await db.insert(auditLog).values({ userId: decisionUserId, objectType: "mcp_tool", effect: "allow", ruleId: "credential-audience-violation", ruleChain: [], reason: "synthetic X34", detail: receiptClass === null ? {} : { receiptClass } }).returning();
    ids.push(row!.id);
  }
  expect((await runDecisionReceiptSignSweep(db)).signed).toBe(0);
  expect(await db.select().from(decisionReceipts)).toHaveLength(before);
  const [eligible] = await db.insert(auditLog).values({ userId: decisionUserId, objectType: "mcp_tool", effect: "deny", ruleId: "x34-new-governed-denial", ruleChain: [], reason: "synthetic X34", detail: { receiptClass: "decision" } }).returning();
  expect((await runDecisionReceiptSignSweep(db)).signed).toBe(1);
  const value = await bundle();
  expect(value.receipts.some(r => r.payload.audit.id === eligible!.id)).toBe(true);
  expect(value.receipts.some(r => ids.includes(r.payload.audit.id))).toBe(false);
  expect(verifyReceiptBundle(value).results.every(r => r.status === "valid")).toBe(true);
});
