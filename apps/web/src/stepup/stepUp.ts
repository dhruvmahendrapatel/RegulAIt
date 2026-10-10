/**
 * ADR-0186 A — the browser half of step-up.
 *
 * A protected action answers 403 `step_up_required` with
 * `{actionKind, methods, action:{kind, body}}`. `withStepUp(call)` runs the
 * call; on that refusal it asks the global prompt (`StepUpDialog`) for a
 * grant for exactly that `action`, then runs the SAME call again with
 * `x-regulait-step-up` (every grant collected so far, comma-separated: a write
 * that needs two step-ups gets two). It never loops: an action that is
 * refused again after its grant was sent, a refusal with no methods (an API
 * key) or a cancelled prompt ends it with the refusal.
 *
 * The prompt is a tiny store (one open prompt at a time) so the dialog can be
 * mounted once in the shell and any screen can ask it.
 *
 * `api` here is the request helper for calls that carry the header (the
 * shared client's `api.del` takes no headers). It reports refusals as the
 * shared `ApiError`, so every screen reads them the same way.
 */
import { ApiError, STEP_UP_HEADER, api as sharedApi, onStepUpRequired, type StepUpRequest } from "../api/client";

export interface StepUpAction {
  kind: string;
  body: Record<string, unknown>;
}

export interface StepUpPrompt {
  id: number;
  actionKind: string;
  methods: string[];
  action: StepUpAction;
  /** settles the prompt: a grant token, or null (cancelled) */
  finish: (token: string | null) => void;
}

type PromptListener = (prompt: StepUpPrompt | null) => void;
const promptListeners = new Set<PromptListener>();
let current: StepUpPrompt | null = null;
let nextId = 1;

function publish() {
  for (const l of [...promptListeners]) {
    try {
      l(current);
    } catch {
      // a listener's failure never blocks the prompt
    }
  }
}

/** the dialog subscribes here; returns the unsubscribe function */
export function subscribeStepUpPrompt(listener: PromptListener): () => void {
  promptListeners.add(listener);
  listener(current);
  return () => {
    promptListeners.delete(listener);
  };
}

/** is a dialog mounted to answer prompts? (no dialog → a step-up cannot be asked for) */
export function stepUpPromptAvailable(): boolean {
  return promptListeners.size > 0;
}

/**
 * Ask the person to confirm it's them for `action`. Resolves with a grant
 * token, or null when they cancel (or nothing can ask them). A second ask
 * while one is open cancels the first.
 */
export function promptStepUp(action: StepUpAction, methods: string[]): Promise<string | null> {
  if (!stepUpPromptAvailable()) return Promise.resolve(null);
  current?.finish(null);
  return new Promise((resolve) => {
    const prompt: StepUpPrompt = {
      id: nextId++,
      actionKind: action.kind,
      methods,
      action,
      finish: (token) => {
        if (current === prompt) {
          current = null;
          publish();
        }
        resolve(token);
      },
    };
    current = prompt;
    publish();
  });
}

/** the refusal that names a step-up a person could give, or null */
export function stepUpRefusalOf(err: unknown): { action: StepUpAction; methods: string[] } | null {
  if (!(err instanceof ApiError) || err.status !== 403 || err.payload.error !== "step_up_required") return null;
  const action = err.payload.action as StepUpAction | undefined;
  const methods = Array.isArray(err.payload.methods) ? err.payload.methods.filter((m): m is string => typeof m === "string") : [];
  if (!action || typeof action.kind !== "string" || typeof action.body !== "object" || action.body === null) return null;
  if (methods.length === 0) return null; // an API key, a chat tap, a bulk operation: nobody can step up
  return { action, methods };
}

/** at most one step-up per action kind rides one request (the gateway reads at most six) */
const MAX_STEP_UPS = 6;

/**
 * Run `call`, stepping up when it is refused for that, and retrying it with
 * the grant(s). Never loops (see the header).
 */
export async function withStepUp<T>(
  call: (headers: Record<string, string>) => Promise<T>,
  ask: (action: StepUpAction, methods: string[]) => Promise<string | null> = promptStepUp,
): Promise<T> {
  const tokens: string[] = [];
  const asked = new Set<string>();
  wrapped += 1;
  try {
    for (;;) {
      try {
        return await call(tokens.length > 0 ? { [STEP_UP_HEADER]: tokens.join(", ") } : {});
      } catch (err) {
        const refusal = stepUpRefusalOf(err);
        if (!refusal) throw err;
        const key = JSON.stringify(refusal.action);
        if (asked.has(key) || asked.size >= MAX_STEP_UPS) throw err;
        asked.add(key);
        const token = await ask(refusal.action, refusal.methods);
        if (!token) throw err;
        tokens.push(token);
      }
    }
  } finally {
    wrapped -= 1;
  }
}

/** how many withStepUp calls are in flight (their refusals are answered by them, not the global listener) */
let wrapped = 0;

/**
 * The global listener: a `step_up_required` from a call that is NOT wrapped in
 * `withStepUp` opens the prompt when the shared client offers a way to resend
 * that request with the header (`retry`, see the request to the client's
 * owner); otherwise the refused call's own error tells the person what to do.
 */
export function installGlobalStepUp(): () => void {
  return onStepUpRequired((request: StepUpRequest) => {
    if (wrapped > 0) return;
    const retry = (request as StepUpRequest & { retry?: (headers: Record<string, string>) => Promise<unknown> }).retry;
    if (typeof retry !== "function") return;
    const refusal = stepUpRefusalOf(new ApiError(403, request.payload));
    if (!refusal) return;
    void promptStepUp(refusal.action, refusal.methods).then((token) => {
      if (token) void retry({ [STEP_UP_HEADER]: token }).catch(() => undefined);
    });
  });
}

// ---------------------------------------------------------------------------
// requests that carry headers
// ---------------------------------------------------------------------------

/** the step-up-capable request helper (same CSRF header, same ApiError as the shared client) */
export const api = {
  get: <T>(path: string) => sharedApi.get<T>(path),
  // every write goes through the shared client's header forms: its session-loss
  // handling and its refusal reading (PR #198 round 7: PATCH too, never a raw fetch)
  post: async <T>(path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    (await sharedApi.postWithHeaders<T>(path, body, headers)).body,
  patch: <T>(path: string, body: unknown = {}, headers: Record<string, string> = {}) => sharedApi.patchWithHeaders<T>(path, body, headers),
  put: <T>(path: string, body: unknown = {}, headers: Record<string, string> = {}) => sharedApi.putWithHeaders<T>(path, body, headers),
  del: <T>(path: string, body?: unknown, headers: Record<string, string> = {}) => sharedApi.delWithHeaders<T>(path, headers, body),
};

/**
 * `PUT /v1/org/settings` through step-up: a write that relaxes a setting (or
 * changes break-glass access) is refused with `step_up_required`, confirmed in
 * the dialog, and resent once with the grant. Every settings writer in the app
 * goes through this.
 */
export function putOrgSettings<T = unknown>(body: Record<string, unknown>): Promise<T> {
  return withStepUp((h) => api.put<T>("/v1/org/settings", body, h));
}

// ---------------------------------------------------------------------------
// what each action is, in words (the dialog's first line)
// ---------------------------------------------------------------------------

export const STEP_UP_ACTION_COPY: Readonly<Record<string, string>> = {
  approval_decide: "deciding this approval",
  settings_relax: "loosening a security setting",
  evidence_hold_override: "overriding an incident evidence hold",
  break_glass: "changing break-glass access",
  passkey_manage: "changing your passkeys",
  owner_change: "changing who owns this",
  identity_manage: "changing an agent identity",
};

export const STEP_UP_METHOD_COPY: Readonly<Record<string, string>> = {
  passkey: "Use a passkey",
  totp: "Enter an authenticator code",
  sso: "Sign in again",
};
