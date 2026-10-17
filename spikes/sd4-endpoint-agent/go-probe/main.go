// SD4 spike: a size probe closer to the real agent. It uses only the Go standard library to
// (1) generate an Ed25519 key, (2) build an RFC 9449 DPoP proof JWS and its RFC 7638 JWK
// thumbprint, (3) list the home directory, and (4) construct (but never use) an HTTPS client
// with TLS 1.3 minimum, so net/http and crypto/tls are linked in. It sends nothing: there is no
// network call. It does not read the socket table; the size of that code is not measured here.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"time"
)

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func main() {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(err)
	}
	jwk := map[string]string{"crv": "Ed25519", "kty": "OKP", "x": b64(pub)}
	// RFC 7638: members in lexicographic order, no whitespace.
	canon := fmt.Sprintf(`{"crv":"Ed25519","kty":"OKP","x":"%s"}`, jwk["x"])
	jkt := sha256.Sum256([]byte(canon))
	hdr, _ := json.Marshal(map[string]any{"typ": "dpop+jwt", "alg": "EdDSA", "jwk": jwk})
	jti := make([]byte, 16)
	_, _ = rand.Read(jti)
	claims, _ := json.Marshal(map[string]any{
		"htm": "POST", "htu": "https://gateway.invalid/oauth/token",
		"iat": time.Now().Unix(), "jti": b64(jti),
	})
	signingInput := b64(hdr) + "." + b64(claims)
	sig := ed25519.Sign(priv, []byte(signingInput))
	proof := signingInput + "." + b64(sig)

	home, _ := os.UserHomeDir()
	entries, _ := os.ReadDir(home)

	client := &http.Client{
		Timeout:   10 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13}},
	}
	_ = client

	fmt.Printf("os=%s arch=%s jkt=%s proof_len=%d home_entries=%d\n",
		runtime.GOOS, runtime.GOARCH, b64(jkt[:]), len(proof), len(entries))
}
