/**
 * Session state (ADR-0025). The server is the source of truth: /auth/me says
 * who is signed in and which gates are closed (must-change-password, forced
 * MFA enrollment); this context only mirrors it. A 401 from any API call
 * flips the session to signed-out, and the router redirects to /login with a
 * return-to.
 *
 * The react-query cache is cleared at every identity boundary — sign-out, a
 * session-ending 401, and a completed sign-in. The cache is module-wide and
 * outlives the shell, so without this the next person signing in on the same
 * tab was shown the previous user's approvals, runs and spend straight from
 * memory, with no request ever reaching the server to say otherwise.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, setUnauthorizedHandler } from "../api/client";
import type { AuthMeResponse, MeResponse } from "../api/types";

export interface SessionState {
  /** undefined = probing, null = signed out */
  auth: AuthMeResponse | null | undefined;
  /** /v1/me enrichment (limits) — present once signed in with a user identity */
  me: MeResponse | null;
  refresh: () => Promise<AuthMeResponse | null>;
  signOut: () => Promise<void>;
  /** mark signed-in after a login flow completed (avoids a duplicate probe) */
  applyAuth: (auth: AuthMeResponse) => void;
}

const SessionContext = createContext<SessionState>({
  auth: undefined,
  me: null,
  refresh: async () => null,
  signOut: async () => {},
  applyAuth: () => {},
});

export function useSession() {
  return useContext(SessionContext);
}

export function SessionProvider(props: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthMeResponse | null | undefined>(undefined);
  const [me, setMe] = useState<MeResponse | null>(null);
  const queryClient = useQueryClient();
  // whose data the cache currently holds — null once signed out
  const cacheOwner = useRef<string | null>(null);
  const forget = useCallback(() => {
    queryClient.clear();
    cacheOwner.current = null;
  }, [queryClient]);
  /** a 401 ends a session only if this tab held one. With no owner the cache
   * holds only what was fetched before any sign-in (the sign-in options, a
   * pending account link). Clearing it then protects no one and cancels those
   * queries mid-flight: the signed-out probe (sent twice under StrictMode)
   * could leave the sign-in page on a discarded query, showing the degraded
   * email-only form or "no account link waiting". */
  const forgetSession = useCallback(() => {
    if (cacheOwner.current !== null) forget();
  }, [forget]);
  /** a sign-in (or a probe that finds a different person) starts from an empty
   * cache — BEFORE the shell mounts, so nothing is fetched twice */
  const become = useCallback(
    (a: AuthMeResponse) => {
      const who = a.userId ?? "bootstrap";
      if (cacheOwner.current !== who) forget();
      cacheOwner.current = who;
    },
    [forget],
  );

  const refresh = useCallback(async (): Promise<AuthMeResponse | null> => {
    try {
      const a = await api.get<AuthMeResponse>("/auth/me");
      become(a);
      setAuth(a);
      if (a.userId && !a.mustChangePassword) {
        // /v1/me is behind the password gate; skip it until the gate opens
        try {
          setMe(await api.get<MeResponse>("/v1/me"));
        } catch {
          setMe(null);
        }
      } else {
        setMe(null);
      }
      return a;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        forgetSession();
        setAuth(null);
        setMe(null);
        return null;
      }
      // network/5xx: leave the current state alone, surface nothing here
      setAuth((cur) => (cur === undefined ? null : cur));
      return null;
    }
  }, [become, forgetSession]);

  const signOut = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      // logout is idempotent server-side; clearing local state is what matters
    }
    // nothing fetched under the old identity may outlive it (L4)
    forget();
    setAuth(null);
    setMe(null);
  }, [forget]);

  const applyAuth = useCallback((a: AuthMeResponse) => {
    become(a);
    setAuth(a);
    void (async () => {
      if (a.userId && !a.mustChangePassword) {
        try {
          setMe(await api.get<MeResponse>("/v1/me"));
        } catch {
          setMe(null);
        }
      }
    })();
  }, [become]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      forgetSession();
      setAuth(null);
    });
    void refresh();
    return () => setUnauthorizedHandler(null);
  }, [refresh, forgetSession]);

  const value = useMemo(
    () => ({ auth, me, refresh, signOut, applyAuth }),
    [auth, me, refresh, signOut, applyAuth],
  );
  return <SessionContext.Provider value={value}>{props.children}</SessionContext.Provider>;
}
