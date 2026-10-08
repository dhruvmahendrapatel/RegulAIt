/**
 * The authenticator-enrolment block shared by the forced enrolment at sign-in
 * (views/auth/ForcedMfaEnroll) and self-service enrolment (views/account
 * AccountPage): a scannable QR code of the exact otpauth URI the gateway
 * returned, then the manual key and the URI as text for anyone who cannot scan
 * (no camera, screen reader, the authenticator is on the same device).
 *
 * The code is drawn in the browser by lean-qr (ADR-0176; apps/web/THIRD_PARTY.md)
 * as an inline SVG path: nothing is fetched, nothing is logged, and no image or
 * data: URL is created, so the secret never leaves this component's props.
 * When the URI is missing or is not a TOTP otpauth URI with a secret, no image
 * is drawn and only the manual block shows.
 */
import { useId, useMemo } from "react";
import { correction, generate } from "lean-qr";
import { toSvgPath } from "lean-qr/extras/svg";
import { CodeBlock } from "./kit";
import q from "./totpQrCode.module.css";

/** ISO/IEC 18004 asks for at least four modules of light margin around the code. */
export const QR_QUIET_ZONE = 4;
/** Rendered edge length in CSS pixels; the SVG scales crisply at any zoom. */
export const QR_SIZE_PX = 200;
export const QR_LABEL = "QR code for your authenticator app";

export interface TotpQr {
  /** the SVG path of the dark modules, in module units */
  path: string;
  /** modules per side, excluding the quiet zone */
  size: number;
}

/**
 * The QR code for `uri`, or null when there is nothing safe to draw: a missing
 * value, an unparseable one, anything other than `otpauth://totp/…`, a URI with
 * no `secret`, or text too long for any QR version. The URI is encoded exactly
 * as given, never re-serialised, so the code holds byte-for-byte what the
 * gateway issued.
 */
export function totpQr(uri: string | null | undefined): TotpQr | null {
  if (typeof uri !== "string" || uri.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== "otpauth:" || parsed.host !== "totp" || !parsed.searchParams.get("secret")) return null;
  try {
    // M (~15% recovery) tolerates a smudged or glare-washed screen while keeping
    // a typical enrolment URI at a size phone cameras read easily.
    const code = generate(uri, { minCorrectionLevel: correction.M });
    return { path: toSvgPath(code), size: code.size };
  } catch {
    return null;
  }
}

export function TotpQrCode(props: { secret: string; otpauthUri: string | null | undefined; uriMaxHeight?: string }) {
  const qr = useMemo(() => totpQr(props.otpauthUri), [props.otpauthUri]);
  const headingId = useId();
  const box = qr ? qr.size + 2 * QR_QUIET_ZONE : 0;
  return (
    <div className={q.root}>
      {qr && (
        <figure className={q.figure}>
          {/* Dark modules on a white field in every theme: scanners expect dark-on-light. */}
          <svg
            className={q.code}
            role="img"
            aria-label={QR_LABEL}
            viewBox={`${-QR_QUIET_ZONE} ${-QR_QUIET_ZONE} ${box} ${box}`}
            width={QR_SIZE_PX}
            height={QR_SIZE_PX}
            shapeRendering="crispEdges"
            focusable="false"
            data-testid="totp-qr"
          >
            <rect x={-QR_QUIET_ZONE} y={-QR_QUIET_ZONE} width={box} height={box} fill="#ffffff" />
            <path d={qr.path} fill="#000000" />
          </svg>
          <figcaption className={q.caption}>Scan this QR code with your authenticator app</figcaption>
        </figure>
      )}
      <div className={q.manual} role="group" aria-labelledby={headingId}>
        <span id={headingId} className={q.manualHeading}>
          {qr ? "Can't scan? Enter this key manually" : "Enter this key in your authenticator app"}
        </span>
        <span className={q.secretValue}>{props.secret}</span>
        {props.otpauthUri ? (
          <>
            <span>Or paste the full otpauth URI into an app that accepts it:</span>
            <CodeBlock maxHeight={props.uriMaxHeight ?? "90px"}>{props.otpauthUri}</CodeBlock>
          </>
        ) : null}
      </div>
    </div>
  );
}
