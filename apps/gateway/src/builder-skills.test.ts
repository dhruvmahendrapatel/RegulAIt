/**
 * ADR-0172 — the builder skills library: CRUD, visibility, edit authz,
 * SKILL.md import, usage counts, and that attached skills reach the runtime
 * prompt (and archived ones stop reaching it).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, auditLog, builderAgents, eq } from "@regulait/db";
import { parseSkillMarkdown } from "@regulait/shared";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { buildSystemPrompt } from "./builder-runtime.js";

let k: BuilderKit;
let owner: Person;
let colleague: Person;
let admin: Person;

const skill = async (who: Person, body: Record<string, unknown>) => {
  const r = await k.req("POST", "/v1/builder/skills", who.auth, { description: "", body: "# x", visibility: "private", ...body });
  expect(r.statusCode, r.body).toBe(201);
  const s = r.json().skill as Record<string, any>;
  // ADR-0175: a non-admin's widening waits for an admin — approve it here, so
  // these tests keep exercising what a workspace skill does
  if (s.requestedVisibility === "workspace") {
    const ok = await k.req("POST", `/v1/admission/skills/${s.id}/visibility`, admin.auth, { decision: "approve" });
    expect(ok.statusCode, ok.body).toBe(200);
    return { ...s, visibility: "workspace", requestedVisibility: null };
  }
  return s;
};
const listIds = async (who: Person) =>
  ((await k.req("GET", "/v1/builder/skills", who.auth)).json().skills as Array<{ id: string }>).map((s) => s.id);

beforeAll(async () => {
  k = await builderKit("bld-skills");
  owner = await k.person("owner");
  colleague = await k.person("colleague");
  admin = await k.person("admin", { admin: true });
}, 120_000);

afterAll(async () => k.close());

describe("skills library", () => {
  it("private skills are the owner's (and admins'); workspace skills are everyone's", async () => {
    const priv = await skill(owner, { name: `Private ${k.RUN}` });
    const ws = await skill(owner, { name: `Shared ${k.RUN}`, visibility: "workspace" });
    expect(priv).toMatchObject({ visibility: "private", ownerName: `owner ${k.RUN}`, usedBy: 0, canEdit: true, body: "# x" });
    expect(await listIds(owner)).toEqual(expect.arrayContaining([priv.id, ws.id]));
    expect(await listIds(colleague)).toContain(ws.id);
    expect(await listIds(colleague)).not.toContain(priv.id);
    expect(await listIds(admin)).toContain(priv.id);
    expect((await k.req("GET", `/v1/builder/skills/${priv.id}`, colleague.auth)).statusCode).toBe(404);
    const read = await k.req("GET", `/v1/builder/skills/${ws.id}`, colleague.auth);
    expect(read.json().skill).toMatchObject({ body: "# x", canEdit: false });
  });

  it("edit and delete are owner or admin; delete removes it from lists", async () => {
    const ws = await skill(owner, { name: `Editable ${k.RUN}`, visibility: "workspace" });
    const denied = await k.req("PATCH", `/v1/builder/skills/${ws.id}`, colleague.auth, { body: "# hijack" });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("not_skill_editor");
    expect((await k.req("DELETE", `/v1/builder/skills/${ws.id}`, colleague.auth)).statusCode).toBe(403);
    const ok = await k.req("PATCH", `/v1/builder/skills/${ws.id}`, owner.auth, { body: "# better", description: "now described" });
    expect(ok.json().skill).toMatchObject({ body: "# better", description: "now described" });
    expect((await k.req("PATCH", `/v1/builder/skills/${ws.id}`, admin.auth, { name: `Admin ${k.RUN}` })).statusCode).toBe(200);
    expect((await k.req("DELETE", `/v1/builder/skills/${ws.id}`, owner.auth)).statusCode).toBe(204);
    expect(await listIds(owner)).not.toContain(ws.id);
    expect((await k.req("GET", `/v1/builder/skills/${ws.id}`, owner.auth)).statusCode).toBe(404);
    for (const rule of ["builder-skill-created", "builder-skill-updated", "builder-skill-deleted"]) {
      const rows = await k.db.select().from(auditLog).where(and(eq(auditLog.objectId, ws.id), eq(auditLog.ruleId, rule)));
      expect(rows.length, rule).toBeGreaterThan(0);
    }
    expect((await k.req("POST", "/v1/builder/skills", owner.auth, { name: "big", body: "x".repeat(20_001), visibility: "private" })).statusCode).toBe(400);
  });

  it("imports a SKILL.md by its frontmatter, and refuses one without it", async () => {
    const md = `---\nname: "Evidence summary ${k.RUN}"\ndescription: Summarise control evidence for an auditor\n---\n# Evidence summary\n\nList found and missing evidence.\n`;
    const r = await k.req("POST", "/v1/builder/skills/import", owner.auth, { markdown: md });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().skill).toMatchObject({
      name: `Evidence summary ${k.RUN}`,
      description: "Summarise control evidence for an auditor",
      visibility: "private",
      body: "# Evidence summary\n\nList found and missing evidence.",
    });
    const bad = await k.req("POST", "/v1/builder/skills/import", owner.auth, { markdown: "# no frontmatter" });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toBe("skill_frontmatter_missing");
    expect(parseSkillMarkdown("---\ndescription: no name\n---\nbody")).toBeNull();
  });

  it("attaching counts usage, refuses a skill the editor cannot see, and feeds the runtime prompt until archived", async () => {
    const agent = (
      await k.req("POST", "/v1/builder/agents", owner.auth, { name: "Skilled", connectionFormat: "shared", computerUse: false, projectId: owner.projectId })
    ).json().agent;
    const s = await skill(owner, { name: `Cite sources ${k.RUN}`, body: "Always cite the section." });
    const theirs = await skill(colleague, { name: `Theirs ${k.RUN}` });
    expect((await k.req("PUT", `/v1/builder/agents/${agent.id}/skills`, owner.auth, { skillIds: [theirs.id] })).statusCode).toBe(404);
    const put = await k.req("PUT", `/v1/builder/agents/${agent.id}/skills`, owner.auth, { skillIds: [s.id] });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().agent.skills).toEqual([
      // ADR-0175 review fix: the pinned name is reported beside the library name
      { id: s.id, name: `Cite sources ${k.RUN}`, pinnedName: `Cite sources ${k.RUN}`, description: "", updateAvailable: false, unavailable: false },
    ]);
    expect(put.json().agent.skillCount).toBe(1);
    expect((await k.req("GET", `/v1/builder/skills/${s.id}`, owner.auth)).json().skill.usedBy).toBe(1);

    const [row] = await k.db.select().from(builderAgents).where(eq(builderAgents.id, agent.id));
    expect(await buildSystemPrompt(k.db, row!, owner.id)).toContain("Always cite the section.");
    await k.req("DELETE", `/v1/builder/skills/${s.id}`, owner.auth);
    expect(await buildSystemPrompt(k.db, row!, owner.id)).not.toContain("Always cite the section.");
    expect((await k.req("GET", `/v1/builder/agents/${agent.id}`, owner.auth)).json().agent.skills).toEqual([]);
  });
});
