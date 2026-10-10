# Offline receipt verification and key retirement

`valid` verifies the signature and the supplied receipt-chain prefix. The
signer's identity still requires independently trusted public keys. It does
not establish when the bytes were signed or whether a private key was
compromised; these limits are returned in `cannotProve` by the online and
offline verifiers.

`retiredAt` stops the gateway signing sweep from using that deployment key
again. It preserves the public key so historical receipts remain verifiable
after rotation. It is not a compromise or revocation attestation. Rejecting
all signatures of retired keys would discard otherwise verifiable history.

Neither `decision.at` nor `firstUsedAt` proves signing time. A sweep can sign a
backlog of decisions made before the current key's first use. Comparing those
two dates would reject legitimate receipts. Proving that specific bytes were
signed before retirement requires independent evidence covering those bytes;
this verifier does not consume or verify such timestamp evidence. A compromised
key can produce backdated payloads, so the lifecycle dates cannot supply that
assurance.

An operator who no longer trusts a key can remove it from their independently
trusted key file. Receipts needing it then report `unverifiable`. The gateway
uses its own recorded public-key registry rather than caller-supplied keys.
A separate signed revocation policy and its historical-evidence semantics
would require an explicit contract decision; it is not modeled here.
