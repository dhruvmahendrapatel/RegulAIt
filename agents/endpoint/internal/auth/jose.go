// Package auth is the agent's side of ADR-0188 S7 for the `endpoint_agent` workload kind (R15 §3.3): ES256 compact
// JWS for the `private_key_jwt` client assertion (RFC 7523), the DPoP proof (RFC 9449), the key-rotation proof
// and the report signature, all made by the device key through go-jose (Apache-2.0) over a crypto.Signer, so a
// hardware key never leaves its hardware.
package auth

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/asn1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"time"

	"github.com/go-jose/go-jose/v4"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

// PublicJWK is the RFC 7517 public JWK of a P-256 key, as the gateway registers it.
func PublicJWK(pub crypto.PublicKey) (map[string]any, error) {
	ec, ok := pub.(*ecdsa.PublicKey)
	if !ok || ec.Curve != elliptic.P256() {
		return nil, errors.New("the device key is not a P-256 ECDSA key")
	}
	b, err := (&jose.JSONWebKey{Key: ec}).MarshalJSON()
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// Thumbprint is the key's RFC 7638 SHA-256 thumbprint, base64url.
func Thumbprint(pub crypto.PublicKey) (string, error) {
	t, err := (&jose.JSONWebKey{Key: pub}).Thumbprint(crypto.SHA256)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(t), nil
}

// ClientID is the RFC 9278 thumbprint URI the gateway uses as the key's client id.
func ClientID(pub crypto.PublicKey) (string, error) {
	t, err := Thumbprint(pub)
	if err != nil {
		return "", err
	}
	return contract.JWKThumbprintURIPrefix + t, nil
}

// opaque adapts a crypto.Signer (ASN.1 DER ECDSA) to go-jose's OpaqueSigner (r||s for ES256).
type opaque struct {
	signer crypto.Signer
	kid    string
}

func (o opaque) Public() *jose.JSONWebKey {
	return &jose.JSONWebKey{Key: o.signer.Public(), KeyID: o.kid}
}

func (o opaque) Algs() []jose.SignatureAlgorithm { return []jose.SignatureAlgorithm{jose.ES256} }

func (o opaque) SignPayload(payload []byte, alg jose.SignatureAlgorithm) ([]byte, error) {
	if alg != jose.ES256 {
		return nil, jose.ErrUnsupportedAlgorithm
	}
	digest := sha256.Sum256(payload)
	der, err := o.signer.Sign(rand.Reader, digest[:], crypto.SHA256)
	if err != nil {
		return nil, err
	}
	var sig struct{ R, S *big.Int }
	if rest, err := asn1.Unmarshal(der, &sig); err != nil || len(rest) != 0 {
		return nil, errors.New("the device key returned a malformed signature")
	}
	out := make([]byte, 64)
	sig.R.FillBytes(out[:32])
	sig.S.FillBytes(out[32:])
	return out, nil
}

// sign makes a compact JWS of claims with typ, either with the public key embedded (`jwk`) or named (`kid`).
func sign(key crypto.Signer, typ string, embed bool, kid string, claims map[string]any) (string, error) {
	opts := (&jose.SignerOptions{EmbedJWK: embed}).WithType(jose.ContentType(typ))
	o := opaque{signer: key}
	if !embed {
		o.kid = kid
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: o}, opts)
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	obj, err := signer.Sign(payload)
	if err != nil {
		return "", err
	}
	return obj.CompactSerialize()
}

func jti() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

// clock is replaced in tests.
var clock = time.Now

// ClientAssertion is the RFC 7523 `private_key_jwt`: iss = sub = the client id, aud = exactly the token endpoint
// URL (the gateway checks it, S5 review item 7), a one-use jti, and a 60 s lifetime.
func ClientAssertion(key crypto.Signer, clientID, tokenEndpoint string) (string, error) {
	kid, err := Thumbprint(key.Public())
	if err != nil {
		return "", err
	}
	now := clock().Unix()
	return sign(key, "JWT", false, kid, map[string]any{
		"iss": clientID, "sub": clientID, "aud": tokenEndpoint, "jti": jti(), "iat": now, "exp": now + 60,
	})
}

// DPoPProof is an RFC 9449 proof for one request. htu has no query or fragment. accessToken is "" for the token
// request; otherwise its hash binds the proof to it (`ath`). nonce is the gateway's latest `DPoP-Nonce`.
func DPoPProof(key crypto.Signer, method, htu, nonce, accessToken string) (string, error) {
	claims := map[string]any{"jti": jti(), "htm": method, "htu": htu, "iat": clock().Unix()}
	if nonce != "" {
		claims["nonce"] = nonce
	}
	if accessToken != "" {
		h := sha256.Sum256([]byte(accessToken))
		claims["ath"] = base64.RawURLEncoding.EncodeToString(h[:])
	}
	return sign(key, contract.TypDPoP, true, "", claims)
}

// RotationProof is ADR-0188 S7's proof of possession of a new key: signed by it, its public JWK embedded, aud
// the rotation route's URL.
func RotationProof(newKey crypto.Signer, rotationURL string) (string, error) {
	return sign(newKey, contract.TypKeyRotation, true, "", map[string]any{"aud": rotationURL, "iat": clock().Unix(), "jti": jti()})
}

// ReportSignature binds an upload's exact bytes to the device key: its claims carry the RFC 9530 Content-Digest
// of the body, the snapshot id and the reports URL. DPoP alone covers the method, URL and token, not the body.
func ReportSignature(key crypto.Signer, clientID, reportsURL, snapshotID, contentDigest string) (string, error) {
	kid, err := Thumbprint(key.Public())
	if err != nil {
		return "", err
	}
	return sign(key, contract.TypReportSignature, false, kid, map[string]any{
		"iss": clientID, "aud": reportsURL, "iat": clock().Unix(), "jti": jti(), "snapshotId": snapshotID, "contentDigest": contentDigest,
	})
}

// ContentDigest is the RFC 9530 `Content-Digest` value for body: `sha-256=:<base64>:`.
func ContentDigest(body []byte) string {
	d := sha256.Sum256(body)
	return "sha-256=:" + base64.StdEncoding.EncodeToString(d[:]) + ":"
}
