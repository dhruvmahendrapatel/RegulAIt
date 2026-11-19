/**
 * ADR-0350 (lane E31): the Endpoint policy page's reads. Every key sits under ["admin"], so the admin kit's
 * invalidation after a write (useAction / RemoveButton) refreshes them.
 */
import { useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../../../api/client";
import { errorText } from "../../../api/format";
import { useSession } from "../../../session/SessionContext";
import { useUserPicker } from "../adminKit";
import { REFUSAL_SENTENCES, type DeviceGroup, type ExceptionPage, type PolicyDevice } from "./endpointPolicyModel";

export const POLICY_KEY = ["admin", "endpoint-policy"] as const;
export const EXCEPTION_PAGE = 50;

export function useDeviceGroups() {
  return useQuery({
    queryKey: [...POLICY_KEY, "groups"],
    queryFn: async () => (await api.get<{ items?: DeviceGroup[] }>("/v1/endpoint-device-groups")).items ?? [],
  });
}

/** newest first, a page at a time (`before` is the oldest row's createdAt) */
export function useCommandExceptions() {
  return useInfiniteQuery({
    queryKey: [...POLICY_KEY, "exceptions"],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<ExceptionPage> => {
      const before = pageParam ? `&before=${encodeURIComponent(pageParam)}` : "";
      const body = await api.get<Partial<ExceptionPage>>(`/v1/endpoint-command-exceptions?limit=${EXCEPTION_PAGE}${before}`);
      return { items: body.items ?? [], next: body.next ?? null, machine: body.machine };
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });
}

/** every enrolled device of every endpoint agent source (the Discovery sources device list, newest first) */
export function usePolicyDevices() {
  return useQuery({
    queryKey: [...POLICY_KEY, "devices"],
    queryFn: async (): Promise<PolicyDevice[]> => {
      const s = await api.get<{ sources?: Array<{ id: string; kind: string }> }>("/v1/discovery/sources");
      const agents = (s.sources ?? []).filter((x) => x.kind === "endpoint_agent");
      const lists = await Promise.all(agents.map((a) => api.get<{ devices?: PolicyDevice[] }>(`/v1/discovery/sources/${a.id}/endpoint-devices`)));
      return lists.flatMap((l) => l.devices ?? []);
    },
  });
}

/** the signed-in person's id, or null (a bootstrap token or an API key has none) */
export function useMyId(): string | null {
  const auth = useSession().auth;
  return auth?.userId ?? auth?.user?.id ?? null;
}

/** people's names, and the active admins a request may name as approver */
export function usePeople(me: string | null) {
  const users = useUserPicker();
  return useMemo(() => {
    const list = users.data?.users ?? [];
    const names = new Map(list.map((u) => [u.id, u.displayName || u.email]));
    const name = (id: string | null | undefined) => (!id ? "—" : id === me ? "You" : (names.get(id) ?? `${id.slice(0, 8)}…`));
    const approvers = list.filter((u) => u.isAdmin && !u.disabledAt && u.id !== me);
    return { name, approvers, loading: users.isLoading, error: users.error, complete: users.data?.complete ?? true };
  }, [users.data, users.isLoading, users.error, me]);
}

/** a refusal from these routes in words; the client's own reading for anything else (step-up guidance included) */
export function refusalText(e: unknown): string {
  if (e instanceof ApiError) {
    const code = typeof e.payload.error === "string" ? e.payload.error : "";
    if (REFUSAL_SENTENCES[code]) return REFUSAL_SENTENCES[code]!;
  }
  return errorText(e);
}
