/**
 * Session state (ADR-0025). The server is the source of truth: /auth/me says
 * who is signed in and which gates are closed (must-change-password, forced
 * MFA enrollment); this context only mirrors it. A 401 from any API call
 * flips the session to signed-out, and the router redirects to /login with a
 * return-to.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
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

  const refresh = useCallback(async (): Promise<AuthMeResponse | null> => {
    try {
      const a = await api.get<AuthMeResponse>("/auth/me");
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
        setAuth(null);
        setMe(null);
        return null;
      }
      // network/5xx: leave the current state alone, surface nothing here
      setAuth((cur) => (cur === undefined ? null : cur));
      return null;
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      // logout is idempotent server-side; clearing local state is what matters
    }
    setAuth(null);
    setMe(null);
  }, []);

  const applyAuth = useCallback((a: AuthMeResponse) => {
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
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth(null));
    void refresh();
    return () => setUnauthorizedHandler(null);
  }, [refresh]);

  const value = useMemo(
    () => ({ auth, me, refresh, signOut, applyAuth }),
    [auth, me, refresh, signOut, applyAuth],
  );
  return <SessionContext.Provider value={value}>{props.children}</SessionContext.Provider>;
}
