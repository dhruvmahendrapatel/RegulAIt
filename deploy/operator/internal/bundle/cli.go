package bundle

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
)

// RunVerifyCommand is the `verify-bundle` command of the operator binary (ADR-0304 §5). The Helm chart's migration
// hook runs it as an init container so the plain-Helm path checks the signed manifest against the same compiled-in
// keyring before any migration. It reads two files and the flags; it makes no network call.
//
// Exit codes: 0 verified, 1 refused (reason on stderr), 2 usage error.
func RunVerifyCommand(args []string, keyring map[string]string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("verify-bundle", flag.ContinueOnError)
	fs.SetOutput(stderr)
	manifest := fs.String("manifest", "", "path to manifest.json (byte-for-byte from the bundle)")
	signature := fs.String("signature", "", "path to manifest.json.sig")
	version := fs.String("version", "", "the version being installed; must equal the manifest's")
	installed := fs.String("installed-version", "", "the version running now; empty on a first install")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *manifest == "" || *signature == "" || *version == "" || fs.NArg() != 0 {
		fmt.Fprintln(stderr, "usage: manager verify-bundle --manifest <file> --signature <file> --version <v> [--installed-version <v>]")
		return 2
	}
	if len(keyring) == 0 {
		fmt.Fprintln(stderr, "verify-bundle: REFUSED: no release key is compiled in")
		return 1
	}
	m, err := readBounded(*manifest)
	if err != nil {
		fmt.Fprintf(stderr, "verify-bundle: REFUSED: ManifestMissing: %v\n", err)
		return 1
	}
	sig, err := readBounded(*signature)
	if err != nil {
		fmt.Fprintf(stderr, "verify-bundle: REFUSED: SignatureMissing: %v\n", err)
		return 1
	}
	res, err := Verify(Input{Manifest: m, Signature: sig, Keyring: keyring, WantVersion: *version, InstalledVersion: *installed})
	if err != nil {
		var r *Refusal
		if errors.As(err, &r) {
			fmt.Fprintf(stderr, "verify-bundle: REFUSED: %s: %s\n", r.Reason, r.Message)
			return 1
		}
		fmt.Fprintf(stderr, "verify-bundle: REFUSED: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "verify-bundle: verified %s, signed by compiled-in key %s, manifest sha256 %s\n", res.Manifest.Version, res.Manifest.SigningKeyID, res.SHA256)
	return 0
}

func readBounded(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, MaxManifestBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > MaxManifestBytes {
		return nil, fmt.Errorf("%s is larger than %d bytes", path, MaxManifestBytes)
	}
	return b, nil
}
