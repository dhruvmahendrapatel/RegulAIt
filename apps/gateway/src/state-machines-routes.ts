/**
 * ADR-0348: `GET /v1/state-machines`, the one machine-readable source an agent or MCP tool reads to learn every
 * declared lifecycle (its states, its events, who may cause each and what each means), and, given a machine and a
 * state, which transitions are allowed from there and why the others are not.
 *
 * Read-only, and it returns the declarations only: no record is read, so there is nothing tenant- or
 * user-specific to leak and every signed-in caller may read it. A record's own refusals (a permission, a blocker)
 * are on that record's `lifecycle` field, where the caller's access is known.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { STATE_MACHINES } from "@regulait/shared";

const query = z
  .object({
    machine: z.string().min(1).max(64).optional(),
    state: z.string().min(1).max(64).optional(),
  })
  .strict();

export const STATE_MACHINES_PATH = "/v1/state-machines";

export function registerStateMachineRoutes(app: FastifyInstance): void {
  app.get(STATE_MACHINES_PATH, async (req, reply) => {
    const parsed = query.safeParse(req.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_query", issues: parsed.error.issues });
    const { machine: id, state } = parsed.data;
    if (id === undefined) {
      if (state !== undefined) return reply.status(400).send({ error: "state_needs_machine", detail: "name the machine the state belongs to" });
      return { machines: Object.values(STATE_MACHINES).map((m) => m.toJSON()) };
    }
    const machine = Object.hasOwn(STATE_MACHINES, id) ? STATE_MACHINES[id] : undefined;
    if (!machine) return reply.status(404).send({ error: "unknown_machine", known: Object.keys(STATE_MACHINES) });
    if (state === undefined) return { machine: machine.toJSON() };
    if (!machine.isState(state)) {
      return reply.status(404).send({ error: "unknown_state", machine: id, states: machine.def.states });
    }
    return { machine: machine.toJSON(), lifecycle: machine.describe(state) };
  });
}
