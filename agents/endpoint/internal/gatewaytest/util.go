package gatewaytest

import (
	"crypto"
	"crypto/rand"
	"encoding/hex"
	"encoding/pem"
)

var cryptoSHA256 = crypto.SHA256

func randomish() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// CAPEM is the fake's certificate, for the agent's pinned CA bundle.
func (g *Gateway) CAPEM() []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: g.Server.Certificate().Raw})
}
