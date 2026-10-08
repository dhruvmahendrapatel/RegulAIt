/**
 * The enrolment QR code (ui/TotpQrCode.tsx): a valid TOTP otpauth URI is drawn
 * as an inline SVG of exactly that URI with a white quiet zone and an
 * accessible name; anything else draws no image and leaves only the manual key.
 * Rendered with react-dom/server: no DOM, no browser, just the markup.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { correction, generate } from "lean-qr";
import { toSvgPath } from "lean-qr/extras/svg";
import { describe, expect, it } from "vitest";
import { QR_LABEL, QR_QUIET_ZONE, QR_SIZE_PX, TotpQrCode, totpQr } from "./TotpQrCode";

const SECRET = "JBSWY3DPEHPK3PXP";
const URI = `otpauth://totp/RegulAIt:ada%40example.test?secret=${SECRET}&issuer=RegulAIt&algorithm=SHA1&digits=6&period=30`;

const render = (otpauthUri: string | null | undefined) =>
  renderToStaticMarkup(<TotpQrCode secret={SECRET} otpauthUri={otpauthUri} />);

describe("TotpQrCode — a valid otpauth URI", () => {
  it("draws the exact URI as an SVG QR code", () => {
    const qr = totpQr(URI);
    expect(qr).not.toBeNull();
    // the same modules lean-qr produces for the URI byte-for-byte, not a re-serialised form
    const expected = generate(URI, { minCorrectionLevel: correction.M });
    expect(qr!.size).toBe(expected.size);
    expect(qr!.path).toBe(toSvgPath(expected));
    // a QR symbol is 21 + 4n modules a side (versions 1–40)
    expect((qr!.size - 21) % 4).toBe(0);
    expect(qr!.path.length).toBeGreaterThan(100);
    // and it is the URI that decides the drawing: one changed character changes the code
    expect(totpQr(URI.replace(SECRET, `${SECRET.slice(0, -1)}Q`))!.path).not.toBe(qr!.path);
  });

  it("is stable for a fixed input", () => {
    expect(render(URI)).toBe(render(URI));
    expect(totpQr(URI)).toEqual(totpQr(URI));
  });

  it("renders a labelled image on a white field with a four-module quiet zone, then the manual key", () => {
    const html = render(URI);
    const qr = totpQr(URI)!;
    const box = qr.size + 2 * QR_QUIET_ZONE;
    expect(html).toContain('role="img"');
    expect(html).toContain(`aria-label="${QR_LABEL}"`);
    expect(html).toContain(`viewBox="-4 -4 ${box} ${box}"`);
    expect(html).toContain(`width="${QR_SIZE_PX}" height="${QR_SIZE_PX}"`);
    expect(html).toContain(`<rect x="-4" y="-4" width="${box}" height="${box}" fill="#ffffff"></rect>`);
    expect(html).toContain(`<path d="${qr.path}" fill="#000000"></path>`);
    expect(html).toContain("Scan this QR code with your authenticator app");
    // the manual route stays: the key and the URI as readable text, after the image
    expect(html).toContain("Can&#x27;t scan? Enter this key manually");
    expect(html).toContain(`>${SECRET}<`);
    expect(html).toContain(URI.replace(/&/g, "&amp;"));
    expect(html.indexOf("<svg")).toBeLessThan(html.indexOf(SECRET));
    // nothing that could carry the secret off the page: no data: URL, no <img> source
    expect(html).not.toContain("data:");
    expect(html).not.toContain("<img");
  });
});

describe("TotpQrCode — nothing safe to draw", () => {
  const cases: Array<[string, string | null | undefined]> = [
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["unparseable", "not a uri"],
    ["another scheme", `https://example.test/enrol?secret=${SECRET}`],
    ["HOTP, not TOTP", `otpauth://hotp/RegulAIt:ada?secret=${SECRET}&counter=0`],
    ["no secret", "otpauth://totp/RegulAIt:ada?issuer=RegulAIt"],
    ["too long for any QR version", `otpauth://totp/x?secret=${SECRET}&pad=${"x".repeat(8000)}`],
  ];
  for (const [name, uri] of cases) {
    it(`${name}: no image, only the manual key`, () => {
      expect(totpQr(uri)).toBeNull();
      const html = render(uri);
      expect(html).not.toContain("<svg");
      expect(html).not.toContain('role="img"');
      expect(html).not.toContain("Scan this QR code");
      expect(html).toContain("Enter this key in your authenticator app");
      expect(html).toContain(`>${SECRET}<`);
    });
  }
});
