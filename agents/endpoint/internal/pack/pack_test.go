package pack

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/pack/packtest"
)

const goodCollection = `{"schema":"regulait.endpoint-collection/1","entries":[
 {"signatureId":"sig.example.desktop","kind":"desktop_app","provider":"example","bundleIds":["com.example.assistant"]},
 {"signatureId":"sig.example.config","kind":"assistant_config","provider":"example",
  "files":[{"os":"linux","root":"home","path":".config/example/*.json"}],"keyNames":["EXAMPLE_API_KEY"]}
]}`

func mustRefuse(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil || !errors.Is(err, ErrRefused) || !strings.Contains(err.Error(), want) {
		t.Fatalf("want a refusal containing %q, got %v", want, err)
	}
}

func TestVerifyAcceptsASignedPack(t *testing.T) {
	s := packtest.NewSigner()
	v, err := Verify(s.Pack("1.2.0", []byte(goodCollection)), s.Keyring(), "1.1.9")
	if err != nil {
		t.Fatal(err)
	}
	if v.Version != "1.2.0" || len(v.Collection.Entries) != 2 || len(v.CollectionDigest) != 64 {
		t.Fatalf("%+v", v)
	}
}

func TestVerifyRefusals(t *testing.T) {
	s := packtest.NewSigner()
	other := packtest.NewSigner()
	good := s.Pack("2.0", []byte(goodCollection))

	t.Run("compiled keyring is empty", func(t *testing.T) {
		_, err := Verify(good, CompiledKeyring, "")
		mustRefuse(t, err, "unknown signing key")
	})
	t.Run("unsigned", func(t *testing.T) {
		p := good
		p.Signature = ""
		_, err := Verify(p, s.Keyring(), "")
		mustRefuse(t, err, "no signature")
	})
	t.Run("signed by another key", func(t *testing.T) {
		_, err := Verify(other.Pack("2.0", []byte(goodCollection)), s.Keyring(), "")
		mustRefuse(t, err, "does not verify")
	})
	t.Run("manifest modified after signing", func(t *testing.T) {
		raw, _ := base64.StdEncoding.DecodeString(good.Manifest)
		p := good
		p.Manifest = base64.StdEncoding.EncodeToString([]byte(strings.Replace(string(raw), `"2.0"`, `"9.0"`, 1)))
		_, err := Verify(p, s.Keyring(), "")
		mustRefuse(t, err, "does not verify")
	})
	t.Run("file modified", func(t *testing.T) {
		p := good
		p.Files = map[string]string{contract.CollectionManifestFile: base64.StdEncoding.EncodeToString([]byte(strings.Replace(goodCollection, "assistant", "assistanX", 1)))}
		_, err := Verify(p, s.Keyring(), "")
		mustRefuse(t, err, "does not match its signed digest")
	})
	t.Run("unlisted file", func(t *testing.T) {
		p := good
		p.Files = map[string]string{contract.CollectionManifestFile: good.Files[contract.CollectionManifestFile], "extra.sh": "ZWNobwo="}
		_, err := Verify(p, s.Keyring(), "")
		mustRefuse(t, err, "does not list")
	})
	t.Run("listed file missing", func(t *testing.T) {
		p := good
		p.Files = map[string]string{}
		_, err := Verify(p, s.Keyring(), "")
		mustRefuse(t, err, "missing")
	})
	t.Run("downgrade", func(t *testing.T) {
		_, err := Verify(good, s.Keyring(), "2.0.1")
		mustRefuse(t, err, "downgrade refused")
	})
	t.Run("older than the compiled minimum, with no per-user floor", func(t *testing.T) {
		// a new user, or one whose state was deleted, has no floor; the compiled minimum still refuses
		_, err := Verify(s.Pack("0.9.9", []byte(goodCollection)), s.Keyring(), "")
		mustRefuse(t, err, "this build's minimum "+MinimumVersion)
		if _, err := Verify(s.Pack(MinimumVersion, []byte(goodCollection)), s.Keyring(), ""); err != nil {
			t.Fatalf("the minimum itself: %v", err)
		}
	})
	t.Run("same version is not a downgrade", func(t *testing.T) {
		if _, err := Verify(good, s.Keyring(), "2.0.0"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("key id path traversal", func(t *testing.T) {
		files := map[string][]byte{contract.CollectionManifestFile: []byte(goodCollection)}
		m := strings.Replace(string(packtest.Manifest("2.0", files)), packtest.KeyID, "../../etc/x", 1)
		_, err := Verify(s.SignRaw([]byte(m), files), s.Keyring(), "")
		mustRefuse(t, err, "not a permitted key id")
	})
	t.Run("unknown manifest member", func(t *testing.T) {
		files := map[string][]byte{contract.CollectionManifestFile: []byte(goodCollection)}
		m := strings.Replace(string(packtest.Manifest("2.0", files)), `"schema"`, `"extra": 1, "schema"`, 1)
		_, err := Verify(s.SignRaw([]byte(m), files), s.Keyring(), "")
		mustRefuse(t, err, "does not parse")
	})
}

func TestCollectionRefusals(t *testing.T) {
	cases := map[string]string{
		"unknown kind":        `{"signatureId":"a","kind":"keylogger","provider":"p","executables":["x"]}`,
		"regex in a name":     `{"signatureId":"a","kind":"cli","provider":"p","executables":["(x|y)"]}`,
		"glob in a name":      `{"signatureId":"a","kind":"cli","provider":"p","executables":["x*"]}`,
		"anchored pattern":    `{"signatureId":"a","kind":"env_name","provider":"p","envNames":["^KEY$"]}`,
		"class in a path":     `{"signatureId":"a","kind":"assistant_config","provider":"p","files":[{"os":"linux","root":"home","path":".x/[ab].json"}]}`,
		"absolute path":       `{"signatureId":"a","kind":"assistant_config","provider":"p","files":[{"os":"linux","root":"home","path":"/etc/shadow"}]}`,
		"parent segment":      `{"signatureId":"a","kind":"assistant_config","provider":"p","files":[{"os":"linux","root":"home","path":"../other/x"}]}`,
		"recursive glob":      `{"signatureId":"a","kind":"assistant_config","provider":"p","files":[{"os":"linux","root":"home","path":"**/x"}]}`,
		"backslash path":      `{"signatureId":"a","kind":"assistant_config","provider":"p","files":[{"os":"windows","root":"appdata","path":"x\\y"}]}`,
		"wrong root for os":   `{"signatureId":"a","kind":"assistant_config","provider":"p","files":[{"os":"linux","root":"appdata","path":"x"}]}`,
		"field of other kind": `{"signatureId":"a","kind":"cli","provider":"p","executables":["x"],"ports":[1]}`,
		"no identifier":       `{"signatureId":"a","kind":"cli","provider":"p"}`,
		"bad port":            `{"signatureId":"a","kind":"local_runtime","provider":"p","ports":[70000]}`,
		"bad signature id":    `{"signatureId":"A B","kind":"cli","provider":"p","executables":["x"]}`,
		"unknown member":      `{"signatureId":"a","kind":"cli","provider":"p","executables":["x"],"regex":"."}`,
	}
	for name, entry := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := ParseCollection([]byte(`{"schema":"regulait.endpoint-collection/1","entries":[` + entry + `]}`))
			if err == nil || !errors.Is(err, ErrRefused) {
				t.Fatalf("accepted: %s", entry)
			}
		})
	}
	t.Run("duplicate signature id", func(t *testing.T) {
		e := `{"signatureId":"a","kind":"cli","provider":"p","executables":["x"]}`
		_, err := ParseCollection([]byte(`{"schema":"regulait.endpoint-collection/1","entries":[` + e + `,` + e + `]}`))
		mustRefuse(t, err, "twice")
	})
	t.Run("unknown schema", func(t *testing.T) {
		_, err := ParseCollection([]byte(`{"schema":"other/1","entries":[]}`))
		mustRefuse(t, err, "unknown collection schema")
	})
	// the absolute-path guard itself: each is refused as absolute (the drive-letter forms pass every other check)
	for _, l := range []string{
		`{"os":"linux","root":"home","path":"/etc/shadow"}`,
		`{"os":"windows","root":"appdata","path":"C:/Windows/System32/config/SAM"}`,
		`{"os":"windows","root":"localappdata","path":"d:x"}`,
	} {
		t.Run("absolute "+l, func(t *testing.T) {
			e := `{"signatureId":"a","kind":"assistant_config","provider":"p","files":[` + l + `]}`
			_, err := ParseCollection([]byte(`{"schema":"regulait.endpoint-collection/1","entries":[` + e + `]}`))
			mustRefuse(t, err, "path is absolute")
		})
	}
}
