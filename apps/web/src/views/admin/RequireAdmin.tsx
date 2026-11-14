/**
 * The admin route guard, on its own so the entry bundle (App.tsx renders it around every /admin route) carries
 * only the guard and not the rest of adminKit, which every admin screen loads in its own lazy chunk. It stays a
 * static import: the guard renders before any admin screen is fetched. adminKit re-exports it.
 */
import type { ReactNode } from "react";
import { useSession } from "../../session/SessionContext";
import { Card, ErrorState, SkeletonBlock } from "../../ui/kit";

/**
 * The admin boundary. Default-deny, and it says so.
 *
 * This used to bounce a non-admin silently to Home, which is not a refusal —
 * it is a disappearance, and the person who typed the URL is left unable to
 * tell "I am not allowed" from "that page does not exist". Every governed
 * refusal in this product names itself; the client-side one now does too. The
 * gateway refuses these routes independently (they are absent from
 * `NON_ADMIN_ROUTES`), so this is the readable half of a two-sided deny, never
 * the enforcement.
 */
export function RequireAdmin(props: { children: ReactNode }) {
  const { auth } = useSession();
  if (auth === undefined) return <SkeletonBlock lines={4} />;
  if (!auth?.isAdmin) {
    return (
      <Card>
        <ErrorState
          access
          message={
            "This is an administrative surface and your account does not hold the administrator role. " +
            "It is not listed in your navigation for the same reason. The server refuses these endpoints " +
            "independently of this screen, so nothing here was hidden from you and then left reachable."
          }
        />
      </Card>
    );
  }
  return <>{props.children}</>;
}
