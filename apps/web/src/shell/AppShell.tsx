/**
 * The application shell: grouped left nav (with the "/" quick filter), topbar
 * (user menu, theme toggle), and — for admins — the full native admin surface
 * (phase 2): every group is a set of real /ui routes inside this shell.
 * ADR-0033 removed the legacy consoles entirely, so this shell is the whole
 * product surface — there are no outbound bridges left.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Approval } from "../api/types";
import { useSession } from "../session/SessionContext";
import { useTheme } from "../ui/useTheme";
import { Lockup } from "../ui/Brand";
import { InfoButton } from "../ui/kit";
import { ADMIN_GROUPS, SUITES, WORKSPACE, SuiteGlyph, suiteHome, suiteOfPath, type NavEntry } from "./suites";
import { NavGlyph, RailGlyph } from "./navIcons";
import { CommandPalette } from "./CommandPalette";
import StepUpDialog from "../stepup/StepUpDialog";
// ADR-0182 (D4) A14: the acknowledgement interstitial's slot (A14's file)
import AcknowledgeGate from "../views/account/AcknowledgeGate";
import s from "./shell.module.css";


/**
 * route path → the nav section it lives under, so a page header can state where
 * it is without every view repeating what the nav already declares. Workspace
 * routes are deliberately absent: they are top-level, so they have no trail.
 */
const GROUP_OF_PATH = new Map<string, string>(
  ADMIN_GROUPS.flatMap((g) => g.items.map((n) => [n.to, g.group] as const)),
);

/**
 * ADR-0169 — the rail auto-hides to an icon strip; a pin keeps it open. The
 * choice is per browser. Storage can be unavailable (private windows, blocked
 * site data), so every access is guarded and the default — auto-hide — is what
 * a failed read yields.
 */
export const RAIL_PIN_KEY = "regulait.rail.pinned";
function readPinned(): boolean {
  try {
    return localStorage.getItem(RAIL_PIN_KEY) === "1";
  } catch {
    return false;
  }
}
function writePinned(v: boolean) {
  try {
    localStorage.setItem(RAIL_PIN_KEY, v ? "1" : "0");
  } catch {
    /* the pin still works for this tab */
  }
}
/** how long the pointer must rest on the strip before it opens — a pass across
 *  it on the way to somewhere else must not throw a panel over the page */
const HOVER_INTENT_MS = 160;

function isKeyboardFocus(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

export default function AppShell(props: { children: ReactNode }) {
  const { auth, signOut } = useSession();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /*
   * ADR-0169 — rail state. Three independent reasons to show the full rail:
   *  - pinned: the person chose it (remembered per browser); content makes room.
   *  - focusOpen: KEYBOARD focus is inside the rail (`:focus-visible`, so a
   *    mouse click on a link does not count). Content makes room too, so a
   *    keyboard user never has the panel drawn over what they are reading.
   *  - hoverOpen: the pointer has rested on the strip. The rail opens OVER
   *    the content, near-opaque, and closes the moment the pointer leaves.
   * Choosing a destination closes a hover/focus-opened rail, and the pointer
   * that chose it must leave and come back before hover re-opens it.
   */
  const [pinned, setPinned] = useState<boolean>(readPinned);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const hoverTimer = useRef<number | undefined>(undefined);
  const hoverSuppressed = useRef(false);
  const pointerInside = useRef(false);
  const railRef = useRef<HTMLElement>(null);
  const expanded = pinned || hoverOpen || focusOpen;
  const railMode = pinned ? "pinned" : focusOpen ? "open" : hoverOpen ? "overlay" : "collapsed";

  const clearHoverTimer = useCallback(() => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = undefined;
  }, []);
  const closeRail = useCallback(() => {
    clearHoverTimer();
    // only a pointer that is still ON the rail is held off; a keyboard choice
    // must not make the next hover do nothing
    hoverSuppressed.current = pointerInside.current;
    setHoverOpen(false);
    setFocusOpen(false);
  }, [clearHoverTimer]);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  // The topbar is clear over the field at the top of the page and frosts only
  // once content scrolls under it — a band where one is needed, none otherwise.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const togglePin = () => {
    setPinned((p) => {
      writePinned(!p);
      return !p;
    });
  };

  // pending-inbox count for the nav badge (soft-refreshing, never blocking)
  const inbox = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api.get<{ approvals: Approval[] }>("/v1/approvals"),
    refetchInterval: 30_000,
  });
  const pendingCount = (inbox.data?.approvals ?? []).filter((a) => a.status === "pending").length;

  // "/" focuses the nav filter from anywhere outside a form control
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
        return;
      }
      e.preventDefault();
      setSideOpen(true);
      setFocusOpen(true);
      filterRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // ADR-0173 §4 — Ctrl/⌘-K opens (and closes) the command palette from
  // anywhere, form fields included: it is the one global shortcut, and the
  // browser's own Ctrl-K (focus the address bar's search) is what it replaces
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      setMenuOpen(false);
      setPaletteOpen((o) => !o);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // click-away closes the user menu
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const { pathname } = useLocation();
  const q = filter.trim().toLowerCase();

  /**
   * ADR-0094 — suite-scoped navigation. The suites a user can see (non-admins
   * see only Workspace), the suite the current route belongs to, and the two
   * render modes:
   *  - filter EMPTY: only the active suite's sections render, under a compact
   *    suite identity header with the switcher. Someone working in one suite
   *    is not confronted with every other product's nav.
   *  - filter NON-EMPTY: the "/" filter searches ACROSS ALL destinations in
   *    every visible suite — it is the escape hatch, and scoping it to the
   *    current suite would strand users (the ADR states this as an invariant).
   */
  const suites = useMemo(
    () => SUITES.filter((su) => !su.admin || auth?.isAdmin),
    [auth?.isAdmin],
  );
  const activeSuite = useMemo(() => suiteOfPath(pathname, Boolean(auth?.isAdmin)), [pathname, auth?.isAdmin]);
  const filterResults = useMemo(() => {
    if (!q) return [];
    return suites
      .flatMap((su) => su.sections)
      .map((g) =>
        // Home is a constant affordance, not a suite entry — but the filter
        // must still be able to find it
        g.group === "Workspace" ? { group: g.group, items: [{ label: "Home", to: "/" }, ...g.items] } : g,
      )
      .map((g) => ({
        group: g.group,
        items: g.items.filter(
          (n) => n.label.toLowerCase().includes(q) || g.group.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [suites, q]);

  const navEntry = (n: NavEntry) => (
    <NavLink
      key={n.to}
      to={n.to}
      end={n.to === "/"}
      className={({ isActive }) =>
        isActive || (n.also ?? []).some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
          ? s.navItemActive!
          : s.navItem!
      }
      onClick={() => {
        setSideOpen(false);
        setFilter("");
        closeRail();
      }}
    >
      <NavGlyph to={n.to} label={n.label} className={s.navIcon} />
      <span className={s.navLabel}>{n.label}</span>
      {n.to === "/inbox" && pendingCount > 0 && (
        <span className={s.navCount} aria-label={`${pendingCount} pending approvals`}>
          {pendingCount}
        </span>
      )}
    </NavLink>
  );

  const onRailFocus = (e: FocusEvent<HTMLElement>) => {
    if (isKeyboardFocus(e.target)) setFocusOpen(true);
  };
  const onRailBlur = (e: FocusEvent<HTMLElement>) => {
    const next = e.relatedTarget as Node | null;
    if (!next || !railRef.current?.contains(next)) setFocusOpen(false);
  };

  const displayName = auth?.user?.displayName ?? "Operator";
  const initials = displayName
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className={s.shell} data-rail={railMode}>
      {/* The first focusable element on the page — before the sidebar — so a
          keyboard user reaches content in one tab rather than tabbing through
          every nav item first. */}
      <a href="#rgMain" className="rg-skip-link">
        Skip to main content
      </a>
      <aside
        ref={railRef}
        className={[s.side, sideOpen ? s.sideOpen : ""].join(" ")}
        aria-label="Primary navigation"
        data-expanded={expanded ? "true" : "false"}
        data-testid="nav-rail"
        onPointerEnter={() => {
          pointerInside.current = true;
        }}
        // Armed by MOVEMENT, not by entering: a pointer that merely happens to
        // rest where the rail renders (page load, a layout change) is not
        // someone reaching for the navigation.
        onPointerMove={(e) => {
          pointerInside.current = true;
          if (e.pointerType !== "mouse" || pinned || hoverOpen || hoverSuppressed.current) return;
          if (e.movementX === 0 && e.movementY === 0) return;
          if (hoverTimer.current !== undefined) return;
          hoverTimer.current = window.setTimeout(() => {
            hoverTimer.current = undefined;
            setHoverOpen(true);
          }, HOVER_INTENT_MS);
        }}
        onPointerLeave={() => {
          pointerInside.current = false;
          clearHoverTimer();
          hoverSuppressed.current = false;
          setHoverOpen(false);
        }}
        onPointerDown={clearHoverTimer}
        onFocus={onRailFocus}
        onBlur={onRailBlur}
        onKeyDown={(e) => {
          // Escape closes an auto-opened rail from anywhere inside it
          if (e.key === "Escape" && !pinned) {
            setHoverOpen(false);
            setFocusOpen(false);
          }
        }}
      >
        {/* The rail follows the theme now (ADR-0169), so the lockup does too:
            "auto" tone takes the theme's ink for the anchor nodes. */}
        <div className={s.brand}>
          <Lockup descriptor="governed" tone="auto" />
        </div>
        <div className={s.filterWrap}>
          <RailGlyph name="search" className={s.filterIcon} />
          <input
            ref={filterRef}
            className={s.navFilter}
            placeholder="Filter nav — press /"
            aria-label="Filter navigation"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setFilter("");
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        </div>
        {q ? (
          /* the escape hatch: matches from EVERY suite, grouped by section */
          filterResults.length > 0 ? (
            filterResults.map((g) => (
              <div key={g.group}>
                <div className={s.section}>
                    <span className={s.sectionLabel}>{g.group}</span>
                  </div>
                {g.items.map(navEntry)}
              </div>
            ))
          ) : (
            <div className={s.filterEmpty}>No destination matches</div>
          )
        ) : (
          <>
            {/* the two constant affordances: back to the launcher, and the
                suite switcher (a native select — keyboard accessible for
                free, and compact at every width) */}
            {navEntry({ label: "Home", to: "/" })}
            {suites.length > 1 && (
              <div className={s.suiteHead}>
                <span className={s.suiteGlyph} aria-hidden>
                  <SuiteGlyph suiteId={activeSuite.id} />
                </span>
                <div className={s.suiteName}>{activeSuite.name}</div>
                <select
                  className={s.suiteSwitch}
                  aria-label="Switch suite"
                  value={activeSuite.id}
                  onChange={(e) => {
                    const target = suites.find((su) => su.id === e.target.value);
                    if (target && target.id !== activeSuite.id) {
                      setSideOpen(false);
                      closeRail();
                      navigate(target.id === "workspace" ? "/" : suiteHome(target));
                    }
                  }}
                >
                  {suites.map((su) => (
                    <option key={su.id} value={su.id}>
                      {su.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {activeSuite.sections.map((g) => (
              <div key={g.group}>
                {/* a section heading only where it adds information: inside a
                    suite that presents more than one ADR-0093 section, or the
                    plain Workspace list a non-admin sees */}
                {(activeSuite.sections.length > 1 || suites.length === 1) && (
                  <div className={s.section}>
                    <span className={s.sectionLabel}>{g.group}</span>
                  </div>
                )}
                {g.items.map(navEntry)}
              </div>
            ))}
          </>
        )}
        <div className={s.railFoot}>
          {/* ADR-0169 — the pin. A toggle button (aria-pressed) with a constant
              name, so its state is announced rather than its label changing. */}
          <button
            type="button"
            className={s.pinBtn}
            aria-pressed={pinned}
            title={pinned ? "Unpin: let the navigation auto-hide" : "Pin: keep the navigation open"}
            onClick={togglePin}
          >
            <RailGlyph name={pinned ? "pinOff" : "pin"} className={s.navIcon} />
            <span className={s.navLabel}>Pin navigation</span>
          </button>
        </div>
        {/* The two "legacy ↗" bridges are gone: ADR-0033 deleted the
            single-file shells they pointed at, so a link here would be a dead
            end — the exact failure phase 1 refused to ship. */}
        {/* No endorsement line and no tagline here: the brand puts those in
            footers, sign-in screens and legal surfaces — never in the app
            chrome, where they only add a fourth text style to the rail. */}
      </aside>

      <div className={s.mainCol}>
        <header className={s.topbar} data-scrolled={scrolled ? "true" : "false"}>
          <button
            className={`${s.iconBtn} ${s.hamburger}`}
            aria-label="Toggle navigation"
            aria-expanded={sideOpen}
            onClick={() => setSideOpen((o) => !o)}
          >
            ☰
          </button>
          {/* No "regulAIt workspace" label: the lockup in the rail already
              says whose product this is, and the topbar is part of the canvas.
              ADR-0173 §4: the search sits at the START of the bar, where the
              page beneath holds its title rather than its actions, so the
              sticky bar never lays a control over a page's own buttons. */}
          <button
            type="button"
            className={s.searchBtn}
            aria-haspopup="dialog"
            aria-expanded={paletteOpen}
            aria-keyshortcuts="Control+K Meta+K"
            onClick={() => setPaletteOpen(true)}
          >
            <RailGlyph name="search" className={s.searchBtnIcon} />
            <span>Search</span>
            <kbd className={s.kbd} aria-hidden>
              {typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K"}
            </kbd>
          </button>
          <span className={s.topbarSpacer} />
          <button
            className={s.iconBtn}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={toggle}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <div style={{ position: "relative" }} ref={menuRef}>
            <button
              className={s.userBtn}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <span className={s.avatar} aria-hidden>
                {initials}
              </span>
              {displayName}
            </button>
            {menuOpen && (
              <div className={s.menu} role="menu">
                <div className={s.menuHead}>
                  <div className={s.menuName}>{displayName}</div>
                  <div className={s.menuEmail}>{auth?.user?.email ?? "bootstrap operator"}</div>
                </div>
                <button
                  className={s.menuItem}
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    navigate("/account");
                  }}
                >
                  Account
                </button>
                <button
                  className={s.menuItem}
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    navigate("/account?section=password");
                  }}
                >
                  Change password
                </button>
                <button
                  className={s.menuItem}
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    navigate("/account?section=mfa");
                  }}
                >
                  Two-factor authentication
                </button>
                <button
                  className={s.menuItem}
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    navigate("/account?section=keys");
                  }}
                >
                  Your model keys
                </button>
                <button className={s.menuDanger} role="menuitem" onClick={() => void signOut()}>
                  Sign out
                </button>
              </div>
            )}
          </div>
        </header>
        {/* tabindex="-1" makes this a valid skip-link target without adding it
            to the tab order. It must keep a resolved height — see .content. */}
        <main id="rgMain" tabIndex={-1} className={s.content}>
          <AcknowledgeGate>{props.children}</AcknowledgeGate>
        </main>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        isAdmin={Boolean(auth?.isAdmin)}
        userId={auth?.userId ?? null}
      />
      {/* ADR-0186 A: the one "confirm it's you" dialog (step-up), for every screen */}
      <StepUpDialog />
    </div>
  );
}

/**
 * Consistent page header — every view uses it.
 *
 * Breadcrumb as kicker, then title, then the primary action right-aligned. The
 * breadcrumb *states where you are* rather than offering navigation, which is
 * why its items are plain text and only the last carries `aria-current="page"`.
 */
export function PageHeader(props: {
  title: string;
  crumbs?: string[];
  sub?: ReactNode;
  /**
   * The long-form "what is this screen for" explanation.
   *
   * Most of these pages used to carry three or four sentences of it as the
   * subtitle. That prose is good and it was in the wrong place: read once it is
   * essential, read every day after that it is furniture, and furniture is what
   * teaches people to skim past the sentence that mattered. `sub` is now one
   * line that orients; `info` is the paragraph, one click away for whoever
   * wants it and off the screen of whoever does not.
   */
  info?: ReactNode;
  actions?: ReactNode;
}) {
  // Where a page sits is already known: it is the nav group the current route
  // belongs to. Deriving the crumb from GROUP_OF_PATH means every admin screen
  // gets a correct trail without 60-odd views each hand-passing one, and the
  // trail cannot drift from the navigation it describes.
  const { pathname } = useLocation();
  const derived = GROUP_OF_PATH.get(pathname.replace(/\/+$/, "") || "/");
  const crumbs = props.crumbs ?? (derived ? [derived] : undefined);
  // No crumbs means there is no trail to state — rendering the title alone as a
  // breadcrumb would just repeat the <h1> immediately below it, to the eye and
  // to a screen reader both.
  const trail = crumbs?.length ? [...crumbs, props.title] : [];
  return (
    <>
      {trail.length > 0 && (
        <nav aria-label="Breadcrumb">
          <ol className={s.crumbs}>
            {trail.map((c, i) => {
              const last = i === trail.length - 1;
              return (
                <li key={`${c}-${i}`} className={last ? s.crumbCurrent : undefined}>
                  {i > 0 && (
                    <span className={s.crumbSep} aria-hidden>
                      /{" "}
                    </span>
                  )}
                  <span {...(last ? { "aria-current": "page" as const } : {})}>{c}</span>
                </li>
              );
            })}
          </ol>
        </nav>
      )}
      <div className={s.pageHeaderRow}>
        {/*
          The info trigger is a SIBLING of the <h1>, never a child of it. Inside
          the heading its label joins the heading's accessible name, so every
          swept page announced as "Scheduled jobs, what is the Scheduled jobs
          page?" — the landmark a screen-reader user navigates by, made longer
          and less distinct on 52 screens at once. Outside it, the heading is
          its title again and the button is its own control.
        */}
        <div className={s.pageTitleRow}>
          <h1 className={s.pageTitle} tabIndex={-1}>
            {props.title}
          </h1>
          {props.info != null && (
            <span className={s.pageTitleInfo}>
              <InfoButton label={`the ${props.title} page`}>{props.info}</InfoButton>
            </span>
          )}
        </div>
        {props.actions}
      </div>
      {props.sub != null ? <p className={s.pageSub}>{props.sub}</p> : <div style={{ height: "var(--s3)" }} />}
    </>
  );
}
