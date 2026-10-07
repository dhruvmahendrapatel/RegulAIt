/** Offline, synthetic OpenSSL TSA for transport-boundary integration tests. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function syntheticTsa() {
  const directory = mkdtempSync(path.join(tmpdir(), "regulait-tsa-transport-"));
  const file = (name: string) => path.join(directory, name);
  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "pipe" });
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2", "-subj", "/CN=Synthetic Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", file("ca.key"), "-out", file("ca.pem"));
  openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-subj", "/CN=Synthetic TSA", "-keyout", file("tsa.key"), "-out", file("tsa.csr"));
  writeFileSync(file("extensions.cnf"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n");
  openssl("x509", "-req", "-in", file("tsa.csr"), "-CA", file("ca.pem"), "-CAkey", file("ca.key"), "-CAcreateserial", "-days", "2", "-sha256", "-extfile", file("extensions.cnf"), "-out", file("tsa.pem"));
  writeFileSync(file("serial"), "01\n");
  writeFileSync(file("tsa.cnf"), `[tsa]\ndefault_tsa = settings\n[settings]\nserial = ${file("serial")}\ncrypto_device = builtin\nsigner_cert = ${file("tsa.pem")}\ncerts = ${file("ca.pem")}\nsigner_key = ${file("tsa.key")}\nsigner_digest = sha256\ndefault_policy = 1.2.3.4.5.6\ndigests = sha256\nordering = yes\ntsa_name = yes\ness_cert_id_chain = yes\ness_cert_id_alg = sha256\n`);
  return {
    trustBundle: file("ca.pem"),
    issue(query: Uint8Array): Buffer {
      writeFileSync(file("query.der"), query);
      openssl("ts", "-reply", "-config", file("tsa.cnf"), "-queryfile", file("query.der"), "-out", file("response.der"));
      return readFileSync(file("response.der"));
    },
    close() { rmSync(directory, { recursive: true, force: true }); },
  };
}
