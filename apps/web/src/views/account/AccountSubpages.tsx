/**
 * The Account page's growing lists on their own pages (P3, #453 c6527514889): every live session and every passkey,
 * each with the same actions as on the Account page. Neither read speaks the list contract (both are the caller's
 * own rows, returned whole), so each full page is the list as it is today, just on its own page. The Account page
 * keeps a five-row preview of each, with the full count in its title.
 */
import { Route, Routes } from "react-router-dom";
import AccountPage, { SessionsCard } from "./AccountPage";
import PasskeysCard from "./PasskeysCard";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import { EmptyState } from "../../ui/kit";
import { SubpageTrail } from "../../ui/ListPreview";

export function AccountSessionsPage() {
  return (
    <>
      <SubpageTrail parent="Account" parentTo="/account" current="Devices & sessions" />
      <PageHeader title="Devices & sessions" sub="Every live session for your account, with where it is now and when it was last seen." />
      <SessionsCard />
    </>
  );
}

export function AccountPasskeysPage() {
  const { auth } = useSession();
  return (
    <>
      <SubpageTrail parent="Account" parentTo="/account" current="Passkeys" />
      <PageHeader title="Passkeys" sub="Every passkey you can use to confirm it's you." />
      {/* the Account page shows passkeys only for a signed-in person; the bootstrap identity has none */}
      {auth?.userId ? (
        <div data-testid="account-passkeys">
          <PasskeysCard />
        </div>
      ) : (
        <EmptyState title="This session has no user identity" body="Passkeys belong to a user. Sign in as a user to manage your own passkeys." />
      )}
    </>
  );
}

/**
 * The Account area: the Account page (with its sessions and passkeys previews) at the index, each full list on its
 * own nested route. One lazy chunk mounted at `/account/*` (App.tsx), so the sub-pages add nothing to the entry
 * bundle (ADR-0196 U4; the SPA route census follows this module — scripts/ui-spa-routes.mjs).
 */
export default function AccountArea() {
  return (
    <Routes>
      <Route index element={<AccountPage />} />
      <Route path="sessions" element={<AccountSessionsPage />} />
      <Route path="passkeys" element={<AccountPasskeysPage />} />
    </Routes>
  );
}
