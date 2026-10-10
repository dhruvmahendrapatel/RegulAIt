/** X43 independent real-PG probes. Compose with the source fixture prefix ending immediately
 * before its first describe. These call product code; no HTTP responses are mocked.
 * X43_EXPECT_FIXED=1 changes the lock-wait regression to its required refusal assertion. */

describe("X43 independent S3 cross-review", () => {
  const childExpiry = new Date(Date.now() + 900_000);
  const root = (cap = M(100), expiry = hour()) => createRootGrant(db, { sponsorUserId: userId, actorIdentityId: ids[0]!, scope: toolScope([T.write]), capMicros: cap, environment: ENV, expiresAt: expiry, projectId: null, binding: inProc });
  const input = (parentGrantId: string, actor = 1, key = randomUUID(), cap = M(25), expiresAt = childExpiry) => ({ parentGrantId, actorIdentityId: ids[actor]!, environment: ENV, projectId: null, scope: toolScope([T.write]), capMicros: cap, expiresAt, binding: inProc, idempotencyKey: key });

  it("two independent pools race twenty children; exactly four reservations of 25 fit a cap100", async () => {
    const r = await root();
    const expiry = new Date(r.expiresAt.getTime() - 1000);
    const out = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => admitChildGrant(i % 2 ? db2 : db, input(r.id, i % 6 + 1, `race-${i}`, M(25), expiry))));
    expect(out.filter(x => x.status === "fulfilled")).toHaveLength(4);
    for (const x of out) if (x.status === "rejected") expect(x.reason.code).toBe("delegation_budget");
    expect(await balances(r.id)).toEqual({ S: 0, R: 100, rem: 0 });
  });

  it("same-request sixteen-way two-pool replay returns one child, one edge and one reserve", async () => {
    const r = await root(); const q = input(r.id);
    const out = await Promise.all(Array.from({ length: 16 }, (_, i) => admitChildGrant(i % 2 ? db2 : db, q)));
    expect(new Set(out.map(x => x.grant.id)).size).toBe(1);
    expect(out.filter(x => !x.replayed)).toHaveLength(1);
    expect(await balances(r.id)).toEqual({ S: 0, R: 25, rem: 75 });
    expect(await db.select().from(delegationAllocations).where(eq(delegationAllocations.parentGrantId, r.id))).toHaveLength(1);
  });

  it("sixteen two-pool settlements of the same usage charge apply exactly once on every edge", async () => {
    const r = await root(); const b = (await admitChildGrant(db, input(r.id, 1))).grant;
    const c = (await admitChildGrant(db2, input(b.id, 2, randomUUID(), M(15)))).grant;
    const q = { usageEventId: randomUUID(), leafGrantId: c.id, amountMicros: M(7) };
    const out = await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? db2 : db).transaction(tx => settleDelegationCharge(tx, q))));
    expect(out.filter(x => x.applied)).toHaveLength(1);
    expect(await balances(r.id)).toEqual({ S: 7, R: 18, rem: 75 });
    expect(await balances(b.id)).toEqual({ S: 7, R: 8, rem: 10 });
    expect(await balances(c.id)).toEqual({ S: 7, R: 0, rem: 8 });
  });

  it("two replicas closing the same subtree release unused capacity once to the immediate parent", async () => {
    const r = await root(); const b = (await admitChildGrant(db, input(r.id, 1, randomUUID(), M(60)))).grant;
    const c = (await admitChildGrant(db2, input(b.id, 2, randomUUID(), M(40)))).grant;
    await db.transaction(tx => settleDelegationCharge(tx, { usageEventId: randomUUID(), leafGrantId: c.id, amountMicros: M(10) }));
    await Promise.all([revokeDelegationGrant(db, { grantId: c.id, reason: "run_ended" }), revokeDelegationGrant(db2, { grantId: c.id, reason: "run_ended" })]);
    expect(await balances(r.id)).toEqual({ S: 10, R: 50, rem: 40 });
    expect(await balances(b.id)).toEqual({ S: 10, R: 0, rem: 50 });
    const [e] = await db.select().from(delegationAllocations).where(eq(delegationAllocations.childGrantId, c.id));
    expect(e).toMatchObject({ status: "closed", drawnMicros: M(10), releasedMicros: M(30) });
  });

  it("credential window is inclusive at notBefore, exclusive at notAfter, and rejects another identity", () => {
    const at = new Date("2026-10-10T00:00:00Z");
    const c = { identityId: ids[0]!, revokedAt: null, notBefore: at, notAfter: new Date(at.getTime() + 1000) };
    expect(credentialLiveAt(c, ids[0]!, at)).toBe(true);
    expect(credentialLiveAt(c, ids[0]!, new Date(at.getTime() - 1))).toBe(false);
    expect(credentialLiveAt(c, ids[0]!, c.notAfter)).toBe(false);
    expect(credentialLiveAt(c, ids[1]!, at)).toBe(false);
    expect(credentialLiveAt({ ...c, revokedAt: at }, ids[0]!, at)).toBe(false);
  });

  it("a committed middle credential expiry on replicaB blocks replicaA admission and fresh chain use", async () => {
    const r = await root(); const k = workloadKey(); const cred = await registerJwk(ids[1]!, k);
    const b = (await admitChildGrant(db, { ...input(r.id, 1), binding: { kind: "dpop" as const, thumbprint: await jkt(k), authCredentialId: cred, audience } })).grant;
    const c = (await admitChildGrant(db, input(b.id, 2))).grant;
    expect((await loadLiveChain(db, c.id))!.failure).toBeNull();
    await db2.execute(sql`update workload_credentials set not_after = now() where id = ${cred}`);
    expect((await loadLiveChain(db, c.id))!.failure?.code).toBe("credential_not_live");
    expect((await refusal(admitChildGrant(db, input(b.id, 3)))).code).toBe("credential_not_live");
    expect(await balances(b.id)).toEqual({ S: 0, R: 25, rem: 0 });
  });

  it("signer rotation preserves old token, credential expiry refuses mint/verify, with opposite process skews", async () => {
    const k = workloadKey(); const cred = await registerJwk(ids[0]!, k);
    const r = await createRootGrant(db, { sponsorUserId: userId, actorIdentityId: ids[0]!, scope: toolScope([T.write]), capMicros: null, environment: ENV, expiresAt: hour(), projectId: null, binding: { kind: "dpop", thumbprint: await jkt(k), authCredentialId: cred, audience } });
    const wall = Date.now(); let token: Awaited<ReturnType<typeof mintDelegatedToken>>;
    vi.useFakeTimers({ toFake: ["Date"] });
    try { vi.setSystemTime(wall + 7200_000); token = await mintDelegatedToken(db, { grantId: r.id, issuer: ISSUER, secrets: SECRETS }); } finally { vi.useRealTimers(); }
    const extraKey = generateKeyPairSync("ed25519").privateKey; writeIssuerKeys([issuerKeys[0]!, extraKey]);
    const next = (await configuredIdentitySigningKeys()).find(x => x.kid !== token.kid)!;
    await rotateIdentitySigningKey(db2, { kid: next.kid, actorUserId: userId });
    const proof = await dpopProof(k, { token: token.accessToken });
    vi.useFakeTimers({ toFake: ["Date"] });
    try { vi.setSystemTime(wall - 7200_000); expect((await verify(resourceRequest(token.accessToken, proof))).ok).toBe(true); } finally { vi.useRealTimers(); }
    await db2.execute(sql`update workload_credentials set not_after = now() where id = ${cred}`);
    await expect(mintDelegatedToken(db, { grantId: r.id, issuer: ISSUER, secrets: SECRETS })).rejects.toMatchObject({ code: "chain_not_live" });
    expect((await verify(resourceRequest(token.accessToken, await dpopProof(k, { token: token.accessToken })))).ok).toBe(false);
    writeIssuerKeys(issuerKeys);
  });

  it("compromised issuer revoked on replicaB invalidates old token and prevents automatic new signer on replicaA", async () => {
    const signer = generateKeyPairSync("ed25519").privateKey;
    const replacement = generateKeyPairSync("ed25519").privateKey;
    writeIssuerKeys([signer]);
    const [{ kid }] = await configuredIdentitySigningKeys();
    await rotateIdentitySigningKey(db2, { kid, actorUserId: userId });
    const k = workloadKey(); const cred = await registerJwk(ids[0]!, k);
    const r = await createRootGrant(db, { sponsorUserId: userId, actorIdentityId: ids[0]!, scope: toolScope([T.write]), capMicros: null, environment: ENV, expiresAt: hour(), projectId: null, binding: { kind: "dpop", thumbprint: await jkt(k), authCredentialId: cred, audience } });
    const t = await mintDelegatedToken(db, { grantId: r.id, issuer: ISSUER, secrets: SECRETS });
    expect((await verify(resourceRequest(t.accessToken, await dpopProof(k, { token: t.accessToken })))).ok).toBe(true);
    const wall = Date.now(); vi.useFakeTimers({ toFake: ["Date"] });
    try { vi.setSystemTime(wall - 7200_000); expect((await revokeIdentitySigningKey(db2, { kid, actorUserId: userId })).tokensRevoked).toBeGreaterThanOrEqual(1); } finally { vi.useRealTimers(); }
    expect((await verify(resourceRequest(t.accessToken, await dpopProof(k, { token: t.accessToken })))).ok).toBe(false);
    const [stored] = await db.select().from(issuedTokens).where(eq(issuedTokens.jti, t.jti));
    expect(stored!.revokedAt!.getTime()).toBeGreaterThanOrEqual(stored!.issuedAt.getTime());
    writeIssuerKeys([signer, replacement]);
    await expect(mintDelegatedToken(db, { grantId: r.id, issuer: ISSUER, secrets: SECRETS })).rejects.toMatchObject({ code: "signing_key_unavailable" });
    writeIssuerKeys(issuerKeys);
  });

  it("X43-01 admission waiting on a parent lock must refresh time after that lock, not admit an expired chain", async () => {
    const clock = await databaseNow(db);
    const expires = new Date(clock.getTime() + 1500);
    const r = await root(M(100), expires);
    let release!: () => void; let locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = new Promise<void>(resolve => { locked = resolve; });
    const blocker = db.transaction(async tx => { await tx.select().from(delegationGrants).where(eq(delegationGrants.id, r.id)).for("update"); locked(); await gate; });
    await held;
    const result = admitChildGrant(db2, input(r.id, 1, randomUUID(), M(25), expires)).then(value => ({ value, error: null }), error => ({ value: null, error }));
    // Wait until the request is really blocked, then wait to the DATABASE deadline.
    // This is a concurrency barrier, not an assertion about elapsed wall time.
    try {
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const active = rows<{ waiting: boolean }>(await db.execute(sql`select exists(select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%delegation_grants%') as waiting`))[0]!;
        if (active.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await db.execute(sql`select pg_sleep(greatest(0, extract(epoch from ${expires.toISOString()}::timestamptz - clock_timestamp())) + 0.1)`);
    } finally { release(); await blocker; }
    const out = await result;
    if (process.env.X43_EXPECT_FIXED === "1") {
      expect(out.error?.code, "required refusal after lock wait crosses expiry").toBe("grant_expired");
      expect(out.value).toBeNull();
      expect(await balances(r.id)).toEqual({ S: 0, R: 0, rem: 100 });
      expect(await db.select().from(delegationAllocations).where(eq(delegationAllocations.parentGrantId, r.id))).toHaveLength(0);
    } else {
      expect(out.error).toBeNull();
      expect(out.value!.replayed).toBe(false);
      expect((await loadLiveChain(db, out.value!.grant.id))!.failure?.code).toBe("grant_expired");
      expect(await balances(r.id)).toEqual({ S: 0, R: 25, rem: 75 });
    }
  });
});
