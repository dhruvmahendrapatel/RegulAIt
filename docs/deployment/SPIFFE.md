# SPIFFE workload sign-in (BYOC and air-gapped)

[ADR-0188](../decisions/0188-batch6-agent-workload-identity.md) decisions 10, 11, 12 and 21, built in slice S9.

A worker that runs in your own environment can sign in to RegulAIt's token endpoint with the X.509-SVID your SPIRE
issues it, instead of holding a key registered with us. RegulAIt then issues it a short-lived token bound to that
certificate (RFC 8705). No private key ever leaves your execution plane: RegulAIt stores your trust domain's **public**
CA certificates and the SPIFFE IDs you register, nothing else.

## Secure by default

- **SPIFFE sign-in is off** until an admin uploads a trust bundle for a trust domain. With no bundle, no SVID
  authenticates anything.
- **Nothing is fetched.** RegulAIt never contacts your SPIRE server, a bundle endpoint or the internet for a bundle.
  You export the bundle and upload it, so this works the same in an air gap.
- **Every change is audited and needs a step-up** (`identity_manage`): uploading, replacing and revoking a bundle.
  A step-up confirmed for one bundle cannot be used to upload another.
- **Only CA certificates are accepted.** Each must be a CA with certificate signing, inside its validity window. A
  workload certificate, an expired CA or anything carrying a private key is refused, and nothing is stored.
- **The old variable is ignored.** S5 read bundles from `REGULAIT_SPIFFE_TRUST_BUNDLES`. From S9 it is never read: an
  install that set it has SPIFFE off until the bundle is uploaded. The gateway logs a warning at boot while it is set,
  and the bundle list says so. Remove it once the bundles are uploaded.

## What an SVID must look like

RegulAIt validates every presented certificate itself (decision 21; `pkijs` builds and checks the path, offline). An
SVID is refused when:

- it does not chain to the active bundle of its trust domain, or any certificate on the path is expired or not yet
  valid;
- an issuer on the path is not a CA with certificate signing;
- it is itself a CA, or lacks the `digitalSignature` key usage;
- it has no URI SAN, more than one URI SAN, or a URI SAN that is not a `spiffe://` ID;
- its SPIFFE ID is in another trust domain, or is not exactly the SPIFFE ID registered as the identity's credential.

Behind a reverse proxy, a forwarded client certificate is read only from the header named by
`REGULAIT_CLIENT_CERT_HEADER`, only from a peer listed in `REGULAIT_TRUSTED_PROXIES`, and only when the proxy
authenticates itself to the gateway (mTLS, or the shared secret in `REGULAIT_CLIENT_CERT_PROXY_SECRET`). Otherwise the
header is removed before any route sees it.

## Rotation and revocation

- **Replace** a bundle when your SPIRE CA rotates. The new certificates become the only trust anchors of the domain.
  Nothing is revoked, but an SVID signed by a CA that is no longer in the bundle stops authenticating, including at its
  next use of a certificate-bound token. Upload a bundle holding **both** the old and the new CA while workloads move to
  new SVIDs (SPIRE's own bundle does this during its CA overlap), then the new CA alone.
- **Revoke** a bundle when its CA is compromised. In the same transaction every unexpired token a SPIFFE ID of the
  domain authenticated is revoked; then every delegation grant those IDs authenticated is revoked with its
  descendants. Should that cascade fail for a grant, the response says `cascade: "incomplete"`, an audit row names it,
  and the grant is still refused at its next use. Revocation is never undone: upload a new bundle to trust the domain
  again.

## Runbook

> **Execution status (M-041).** Steps 1 to 4 below were executed on 2026-10-16, verbatim, on a Linux x86-64 build host
> with no RegulAIt deployment: a throwaway single-node SPIRE server, used to produce a real bundle and a real SVID. The
> outputs quoted are from that run. The test vectors in `apps/gateway/src/testing/spire-1.13.3/` came from the same
> commands, and `apps/gateway/src/oauth/spiffe-bundles.test.ts` validates them with RegulAIt's own code. **Every step
> after step 4 is pending execution** on a real BYOC or air-gapped deployment. They are described, and no command is
> given for them, because none has been run.

Throughout, `$DIR` is an empty working directory. Keep its path short: SPIRE's API socket lives in it, and a Unix socket
path is limited to about 100 characters (a long scratch path failed with `connect: invalid argument` on the first try).

### 1. Download SPIRE and check its checksum (executed)

On a connected host. For an air gap, carry the two files across and run the `sha256sum` line there.

```sh
VER=1.13.3
cd "$DIR"
curl -sSLO "https://github.com/spiffe/spire/releases/download/v${VER}/spire-${VER}-linux-amd64-musl.tar.gz"
curl -sSLO "https://github.com/spiffe/spire/releases/download/v${VER}/spire-${VER}-linux-amd64-musl_sha256sum.txt"
sha256sum -c "spire-${VER}-linux-amd64-musl_sha256sum.txt"
tar -xzf "spire-${VER}-linux-amd64-musl.tar.gz"
export PATH="$DIR/spire-${VER}/bin:$PATH"
spire-server --version
```

Output: `spire-1.13.3-linux-amd64-musl.tar.gz: OK` and `1.13.3`.

### 2. A single-node SPIRE server for a test trust domain (executed)

This is a **test** server (SQLite, keys on disk, join-token node attestation) to see the whole flow on one machine.
Your production SPIRE server is yours to run; this runbook does not replace its documentation.

```sh
cat > server.conf <<EOF
server {
  bind_address = "127.0.0.1"
  bind_port = "18081"
  socket_path = "$DIR/api.sock"
  trust_domain = "byoc.example.org"
  data_dir = "$DIR/data"
  log_level = "INFO"
  ca_ttl = "168h"
  default_x509_svid_ttl = "1h"
}
plugins {
  DataStore "sql" {
    plugin_data {
      database_type = "sqlite3"
      connection_string = "$DIR/data/datastore.sqlite3"
    }
  }
  KeyManager "disk" {
    plugin_data {
      keys_path = "$DIR/data/keys.json"
    }
  }
  NodeAttestor "join_token" {
    plugin_data {}
  }
}
EOF
spire-server run -config server.conf > server.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  if spire-server healthcheck -socketPath "$DIR/api.sock"; then break; fi
  sleep 1
done
```

Output: `Server is healthy.` (after one `server is unhealthy` line while it started). The `trap` stops the server
however the session ends: on the first attempt a failed step left it running and holding its port.

### 3. Export the trust bundle (executed)

```sh
spire-server bundle show -format spiffe -socketPath "$DIR/api.sock" > bundle.spiffe.json
spire-server bundle show -format pem -socketPath "$DIR/api.sock" > bundle.pem
grep -c '"use": "x509-svid"' bundle.spiffe.json
```

Output: `1`. `bundle.spiffe.json` is the SPIFFE bundle format: one `x509-svid` key (the CA, in `x5c`) and one `jwt-svid`
key. RegulAIt stores the X.509 CA and counts the `jwt-svid` key as not used (JWT-SVID sign-in is not built). Either file
can be uploaded; both give the same bundle digest.

### 4. A test X.509-SVID, checked with OpenSSL (executed)

```sh
mkdir -p svid
spire-server x509 mint -spiffeID spiffe://byoc.example.org/worker/runtime-1 -ttl 1h -write svid -socketPath "$DIR/api.sock"
openssl x509 -in svid/svid.pem -noout -ext subjectAltName,basicConstraints,keyUsage -dates
openssl verify -CAfile bundle.pem svid/svid.pem
openssl x509 -in bundle.pem -noout -ext basicConstraints,keyUsage
```

Output, abridged: the SVID has `CA:FALSE`, `Digital Signature, Key Encipherment, Key Agreement` and exactly one SAN,
`URI:spiffe://byoc.example.org/worker/runtime-1`; `svid/svid.pem: OK`; the bundle's CA has `CA:TRUE` and
`Certificate Sign, CRL Sign`. That is the shape RegulAIt accepts. `svid/key.pem` is the SVID's private key: it never
goes to RegulAIt.

### 5. Upload the bundle (pending execution)

In the admin portal: **Identity & access → Workload identities → SPIFFE trust bundles**. Enter the trust domain (the
part after `spiffe://`, here `byoc.example.org`), paste `bundle.spiffe.json` (or `bundle.pem`), choose **Upload bundle**,
confirm, and complete the step-up. The screen is covered by the mocked browser suite
(`apps/web/e2e/workload-identities.mock.spec.ts`) and the route by `zz-adr0188-s9-spiffe.test.ts`; neither is a run
against a real deployment.

### 6. Register the workload (pending execution)

Create a `worker_runtime` identity whose identifier is the workload's SPIFFE ID, name its stewards and environments,
then add a credential of type **SPIFFE ID** with the same ID (the credential is refused until step 5 is done for its
trust domain). Grant it what it may do.

### 7. Configure the reverse proxy (pending execution)

The proxy in front of the gateway must request the client certificate, forward it in the header named by
`REGULAIT_CLIENT_CERT_HEADER`, and authenticate to the gateway. The proxy configuration for the bundled Caddy front and
for other proxies is pending: it belongs with the executor TLS front work and has not been run here.

### 8. Exchange the SVID for a token (pending execution)

The worker presents its SVID through the proxy to `POST /oauth/token`, with a person's delegation proof
(`POST /v1/delegations/proofs`), and receives a token bound to the certificate. The request shape is the RFC 8693
exchange of ADR-0188 decision 15 with mTLS client authentication; `zz-adr0188-s9-spiffe.test.ts` drives it through the
real app with a test certificate. No client command is given here until one is run against a deployment.

### 9. Rotation and revocation drills (pending execution)

Rotate the SPIRE CA and replace the bundle with an overlap bundle, then the new CA alone; revoke a bundle and check that
the worker's token is refused at its next call. Both are covered by `zz-adr0188-s9-spiffe.test.ts`, not yet by a drill on
a deployment.

### Air-gapped differences

None in RegulAIt: bundles are uploaded, never fetched, in every mode. Only step 1's download happens on a connected host;
the two files are carried across and checked with `sha256sum -c` there (pending execution in an air gap).
