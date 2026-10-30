/**
 * ADR-0218 (themes phase 2): Settings › Organisation › Themes. The organisation default palette and the lock, saved
 * through the audited `PUT /v1/org/settings` like every other organisation setting (old -> new in the audit log).
 * Lazy-loaded by OrganizationPage, so it stays out of the entry bundle. High contrast always stays selectable by
 * anyone, locked or not (accessibility); light or dark mode is never locked.
 */
import { useState } from "react";
import { putOrgSettings } from "../../../stepup/stepUp";
import { useSession } from "../../../session/SessionContext";
import { PALETTES } from "../../../theme/palette";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { Button, Card, Field, Select } from "../../../ui/kit";
import { useAction } from "../adminKit";
import v from "../../views.module.css";

export default function ThemesCard(props: { settings: Record<string, unknown> }) {
  const { refresh } = useSession();
  const act = useAction();
  const [palette, setPalette] = useState(String(props.settings.themeDefaultPalette ?? "aurora"));
  const [locked, setLocked] = useState(props.settings.themeLocked === true ? "true" : "false");

  const submit = () =>
    void act
      .run(() => putOrgSettings({ themeDefaultPalette: palette, themeLocked: locked === "true" }), "Theme settings saved")
      .then((ok) => {
        // the admin's own console repaints under the new default or lock
        if (ok) void refresh();
      });

  return (
    <Card
      title="8 · Themes"
      infoLabel="Themes"
      info={
        <p>
          The colour palette everyone starts on. Locking it means everyone uses it, but High contrast always stays
          available to anyone, for accessibility. Each person's light or dark mode is never locked. Every change is
          recorded in the audit log.
        </p>
      }
    >
      <form
        className={v.stack}
        data-testid="org-themes"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className={v.grid3}>
          <Field label="Organisation default theme">
            <Select value={palette} onChange={(e) => setPalette(e.target.value)}>
              {PALETTES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Who chooses the theme">
            <Select value={locked} onChange={(e) => setLocked(e.target.value)}>
              <option value="false">Each person chooses their own</option>
              <option value="true">Everyone uses the organisation default</option>
            </Select>
          </Field>
        </div>
        <div className={v.row}>
          <Button type="submit" variant="primary" size="sm" disabled={act.busy}>
            Save theme settings
          </Button>
          {act.error && !act.guidance && (
            <span className={v.errLine} role="alert">
              {act.error}
            </span>
          )}
        </div>
        <RefusalNotice guidance={act.guidance} />
      </form>
    </Card>
  );
}
