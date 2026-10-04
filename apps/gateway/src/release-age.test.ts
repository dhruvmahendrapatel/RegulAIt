/**
 * ADR-0175 A5 — the release-age cooldown.
 *
 * `min_release_age_days` is org-wide state, so this file sets it once and puts
 * it back to 0 before it ends (M-068). Every quarantine is asserted beside its
 * way out: aging past the window (by backdating OUR first-sighting record,
 * which is the clock) or an admin's per-item override with a reason.
 *
 * Nothing here opens a socket: the MCP gate is called directly, and a
 * manifest "sync" is `recordManifestScan` with an in-memory tool list.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  and,
  auditLog,
  builderAgents,
  eq,
  mcpRegistries,
  mcpRegistryEntries,
  mcpServers,
  releaseSightings,
} from "@regulait/db";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { buildSystemPrompt } from "./builder-runtime.js";
import { admissionHidesTools, assertAdmitted, McpAdmissionHeldError, McpReleaseQuarantinedError, recordManifestScan } from "./mcp-admission.js";
import { importRegistryEntry } from "./mcp-registry.js";
import { skillDigest } from "./skill-admission.js";

let k: BuilderKit;
let owner: Person;
let admin: Person;

const DAY = 86_400_000;
const setDays = async (n: number) => {
  const r = await k.req("PUT", "/v1/org/settings", k.BOOT, { minReleaseAgeDays: n });
  expect(r.statusCode, r.body).toBe(200);
};
const ageSkillDigest = async (digest: string, days: number) =>
  k.db
    .update(releaseSightings)
    .set({ firstSeenAt: new Date(Date.now() - days * DAY) })
    .where(and(eq(releaseSightings.kind, "skill"), eq(releaseSightings.digest, digest)));
const skill = async (who: Person, body: Record<string, unknown>) => {
  const r = await k.req("POST", "/v1/builder/skills", who.auth, { description: "", body: "# x", visibility: "private", ...body });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().skill as Record<string, any>;
};
const newAgent = async (who: Person) => {
  const r = await k.req("POST", "/v1/builder/agents", who.auth, {
    name: `Cool ${Math.random().toString(36).slice(2, 7)}`,
    connectionFormat: "shared",
    computerUse: false,
    projectId: who.projectId,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().agent as Record<string, any>;
};
const registerServer = async (name: string) => {
  const r = await k.req("POST", "/v1/servers", k.BOOT, { name, url: "http://127.0.0.1:9/mcp" });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
};
const gate = async (serverId: string) => {
  try {
    await assertAdmitted(k.db, serverId);
    return "admitted";
  } catch (err) {
    if (err instanceof McpReleaseQuarantinedError) return "quarantined";
    throw err;
  }
};
const agentRow = async (id: string) => (await k.db.select().from(builderAgents).where(eq(builderAgents.id, id)))[0]!;
const tools = (desc: string) => [{ name: "lookup", description: desc, inputSchema: { type: "object" } }];

beforeAll(async () => {
  k = await builderKit("rel-age");
  owner = await k.person("owner");
  admin = await k.person("admin", { admin: true });
}, 120_000);

afterAll(async () => {
  // M-068: global state this file created is removed before it ends
  await k.req("PUT", "/v1/org/settings", k.BOOT, { minReleaseAgeDays: 0 });
  await k.close();
});

describe("off (0, the default) quarantines nothing", () => {
  it("a brand-new server and a brand-new skill are usable at once", async () => {
    await setDays(0);
    const id = await registerServer(`rel-off-${k.RUN}`);
    expect(await gate(id)).toBe("admitted");
    expect(await admissionHidesTools(k.db, id)).toBe(false);
    const a = await newAgent(owner);
    const s = await skill(owner, { name: `Off ${k.RUN}`, body: "OFF-BODY" });
    expect((await k.req("PUT", `/v1/builder/agents/${a.id}/skills`, owner.auth, { skillIds: [s.id] })).statusCode).toBe(200);
  });
});

describe("on (7 days)", () => {
  beforeAll(async () => setDays(7));

  it("the setting is validated (0..365) and the review surface shows the recommendation", async () => {
    expect((await k.req("PUT", "/v1/org/settings", k.BOOT, { minReleaseAgeDays: 366 })).statusCode).toBe(400);
    const q = await k.req("GET", "/v1/release-quarantine", admin.auth);
    expect(q.json()).toMatchObject({ enabled: true, minReleaseAgeDays: 7, recommendedDays: 7 });
  });

  it("a newly registered MCP server is quarantined (refused at the gate, hidden from discovery) until old enough", async () => {
    const id = await registerServer(`rel-new-${k.RUN}`);
    expect(await gate(id)).toBe("quarantined");
    expect(await admissionHidesTools(k.db, id)).toBe(true);
    const denied = await k.db.select().from(auditLog).where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, "mcp-release-quarantined")));
    expect(denied.length).toBeGreaterThan(0);
    // the refusal is a held-class error, so every caller's mapping applies
    await expect(assertAdmitted(k.db, id)).rejects.toBeInstanceOf(McpAdmissionHeldError);
    const listed = (await k.req("GET", "/v1/release-quarantine", admin.auth)).json().servers.map((x: { id: string }) => x.id);
    expect(listed).toContain(id);
    // eight days on (our own clock), it is through
    await k.db.update(mcpServers).set({ releaseSeenAt: new Date(Date.now() - 8 * DAY) }).where(eq(mcpServers.id, id));
    expect(await gate(id)).toBe("admitted");
  });

  it("an admin may override one server with a reason (audited); the override covers that release only", async () => {
    const id = await registerServer(`rel-ovr-${k.RUN}`);
    expect(await gate(id)).toBe("quarantined");
    expect((await k.req("POST", "/v1/release-quarantine/override", owner.auth, { kind: "mcp_server", id, reason: "x" })).statusCode).toBe(403);
    expect((await k.req("POST", "/v1/release-quarantine/override", admin.auth, { kind: "mcp_server", id })).statusCode).toBe(400);
    const o = await k.req("POST", "/v1/release-quarantine/override", admin.auth, { kind: "mcp_server", id, reason: "vendor-signed internal server" });
    expect(o.statusCode, o.body).toBe(201);
    expect(await gate(id)).toBe("admitted");
    const audited = await k.db.select().from(auditLog).where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, "release-age-overridden")));
    expect(audited).toHaveLength(1);
    // its first manifest keeps the registration's release (and the override) …
    await recordManifestScan(k.db, id, tools("Looks up a ticket."));
    expect(await gate(id)).toBe("admitted");
    // … a CHANGED manifest is a new release: refused at the sync that saw it, and after
    await expect(recordManifestScan(k.db, id, tools("Looks up a ticket by id."))).rejects.toBeInstanceOf(McpReleaseQuarantinedError);
    expect(await gate(id)).toBe("quarantined");
  });

  it("a changed admitted manifest is aged from the first time THIS deployment saw that exact digest", async () => {
    const id = await registerServer(`rel-drift-${k.RUN}`);
    await k.db.update(mcpServers).set({ releaseSeenAt: new Date(Date.now() - 30 * DAY) }).where(eq(mcpServers.id, id));
    await recordManifestScan(k.db, id, tools("Gets the weather."));
    expect(await gate(id)).toBe("admitted");
    const changed = tools(`Gets the weather for a city ${k.RUN}.`);
    await expect(recordManifestScan(k.db, id, changed)).rejects.toBeInstanceOf(McpReleaseQuarantinedError);
    expect(await gate(id)).toBe("quarantined");
    const [row] = await k.db.select().from(mcpServers).where(eq(mcpServers.id, id));
    const changedRows = await k.db.select().from(auditLog).where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, "mcp-release-changed")));
    expect(changedRows).toHaveLength(1);
    // age is the sighting of that digest — backdate OUR record and the server follows on its next sync
    await k.db
      .update(releaseSightings)
      .set({ firstSeenAt: new Date(Date.now() - 9 * DAY) })
      .where(and(eq(releaseSightings.kind, "mcp_manifest"), eq(releaseSightings.digest, row!.releaseDigest!)));
    // a second server that later serves the SAME manifest is not new: it inherits that age
    const twin = await registerServer(`rel-twin-${k.RUN}`);
    await k.db.update(mcpServers).set({ releaseSeenAt: new Date(Date.now() - 30 * DAY) }).where(eq(mcpServers.id, twin));
    await recordManifestScan(k.db, twin, tools("Gets the weather."));
    await recordManifestScan(k.db, twin, changed);
    expect(await gate(twin)).toBe("admitted");
  });

  it("a federated-registry import is aged from the first sighting of that exact entry version", async () => {
    const [reg] = await k.db.insert(mcpRegistries).values({ name: `rel-reg-${k.RUN}`, url: "http://10.9.9.9/", enabled: false, allowPrivateRanges: true }).returning();
    const [entry] = await k.db
      .insert(mcpRegistryEntries)
      .values({
        registryId: reg!.id,
        upstreamName: `io.example.test/rel-${k.RUN}`,
        upstreamVersion: "1.0.0",
        kind: "remote",
        remoteUrl: `http://rel-${k.RUN}.internal.test/mcp`,
        remoteTransport: "streamable-http",
        // the publisher's claim is old; the cooldown ignores it
        upstreamPublishedAt: new Date(Date.now() - 400 * DAY),
      })
      .returning();
    const out = await importRegistryEntry(k.db, entry!.id, {
      deps: { resolve: async () => [{ address: "10.9.9.10", family: 4 }] },
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const serverId = (out as { ok: true; result: { serverId: string } }).result.serverId;
    expect(await gate(serverId)).toBe("quarantined");
    await k.db.update(mcpServers).set({ releaseSeenAt: new Date(Date.now() - 8 * DAY) }).where(eq(mcpServers.id, serverId));
    expect(await gate(serverId)).toBe("admitted");
  });

  it("a new skill version stays in quarantine (attach and re-attach refused) until aged or overridden", async () => {
    const a = await newAgent(owner);
    const s = await skill(owner, { name: `Cool skill ${k.RUN}`, body: `COOL-ONE ${k.RUN}` });
    expect(s.release).toMatchObject({ quarantined: true });
    const r = await k.req("PUT", `/v1/builder/agents/${a.id}/skills`, owner.auth, { skillIds: [s.id] });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe("skill_release_quarantined");
    expect((await k.req("GET", "/v1/release-quarantine", admin.auth)).json().skills.map((x: { id: string }) => x.id)).toContain(s.id);
    // override this version, with a reason
    const o = await k.req("POST", "/v1/release-quarantine/override", admin.auth, { kind: "skill", id: s.id, reason: "written in-house today" });
    expect(o.statusCode, o.body).toBe(201);
    expect((await k.req("PUT", `/v1/builder/agents/${a.id}/skills`, owner.auth, { skillIds: [s.id] })).statusCode).toBe(200);
    expect(await buildSystemPrompt(k.db, await agentRow(a.id), owner.id)).toContain("COOL-ONE");
    // a new version is a new release: re-attach is refused, the pinned version keeps running
    const v2 = `COOL-TWO ${k.RUN}`;
    await k.req("PATCH", `/v1/builder/skills/${s.id}`, owner.auth, { body: v2 });
    const re = await k.req("POST", `/v1/builder/agents/${a.id}/skills/${s.id}/reattach`, owner.auth);
    expect(re.statusCode, re.body).toBe(409);
    expect(re.json().error).toBe("skill_release_quarantined");
    // age is the first sighting of that exact digest
    await ageSkillDigest(skillDigest(v2), 8);
    expect((await k.req("POST", `/v1/builder/agents/${a.id}/skills/${s.id}/reattach`, owner.auth)).statusCode).toBe(200);
  });

  it("a pinned body still inside the cooldown is withheld from the prompt at run time", async () => {
    const a = await newAgent(owner);
    const body = `SEEDED-${k.RUN}`;
    await setDays(0);
    const s = await skill(owner, { name: `Run time ${k.RUN}`, body });
    await k.req("PUT", `/v1/builder/agents/${a.id}/skills`, owner.auth, { skillIds: [s.id] });
    await setDays(7);
    const row = await agentRow(a.id);
    expect(await buildSystemPrompt(k.db, row, owner.id)).not.toContain(body);
    const detail = (await k.req("GET", `/v1/builder/agents/${a.id}`, owner.auth)).json().agent;
    expect(detail.skills[0]).toMatchObject({ unavailable: true, withheld: "quarantined" });
    await ageSkillDigest(skillDigest(body), 8);
    expect(await buildSystemPrompt(k.db, row, owner.id)).toContain(body);
  });
});
