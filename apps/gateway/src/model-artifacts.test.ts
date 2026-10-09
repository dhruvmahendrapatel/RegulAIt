/**
 * ADR-0187 B5-M — the artifact stores and the upload's helpers, without a database: content-addressed
 * keys only, the bucket verifies our sha256, the bounded stream stops writing past the limit, and a
 * display name never carries a path.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { artifactStorageKey, artifactStoreFromEnv, displayFilename, FileArtifactStore, S3ArtifactStore, streamBounded } from "./model-artifacts.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("B5-M artifact stores", () => {
  it("the filesystem store writes once per sha256, 0600, and refuses any other key", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "b5m-fs-"));
    const store = new FileArtifactStore(dir);
    const bytes = Buffer.from("model bytes");
    const src = path.join(dir, "src.bin");
    await writeFile(src, bytes);
    const key = artifactStorageKey(sha(bytes));
    expect(await store.has(key)).toBe(false);
    await store.putFile(key, src);
    expect(await store.has(key)).toBe(true);
    expect((await stat(path.join(dir, key))).mode & 0o777).toBe(0o600);
    const opened = await store.open(key);
    expect(opened.size).toBe(bytes.length);
    expect(Buffer.concat(await opened.stream.toArray())).toEqual(bytes);
    await expect(store.putFile("../etc/passwd", src)).rejects.toThrow(/invalid artifact key/);
    await expect(store.has("sha256/../../x")).rejects.toThrow(/invalid artifact key/);
  });

  it("PR #212 review [4234946106]: the directory is fsynced after the rename, and every new directory's parent too, before putFile returns", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "b5m-fsync-"));
    const dir = path.join(root, "store");
    const synced: string[] = [];
    const store = new FileArtifactStore(dir, async (d) => {
      synced.push(d);
    });
    const src = path.join(root, "src.bin");
    await writeFile(src, Buffer.from("a"));
    const key = artifactStorageKey(sha(Buffer.from("a")));
    await store.putFile(key, src);
    // `store` and `store/sha256` were created: their parents are fsynced; then the rename's directory
    expect(synced).toEqual([root, dir, path.join(dir, "sha256")]);
    // a second object: nothing new to create, only the rename's directory
    synced.length = 0;
    await writeFile(src, Buffer.from("b"));
    await store.putFile(artifactStorageKey(sha(Buffer.from("b"))), src);
    expect(synced).toEqual([path.join(dir, "sha256")]);
  });

  it("the S3 store sends our sha256 for the bucket to verify, under a fixed prefix", async () => {
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    const client = { send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => (sent.push({ name: cmd.constructor.name, input: cmd.input }), {}) };
    const store = new S3ArtifactStore("bucket", client as never);
    const dir = await mkdtemp(path.join(tmpdir(), "b5m-s3-"));
    const bytes = Buffer.from("weights");
    await writeFile(path.join(dir, "f"), bytes);
    const key = artifactStorageKey(sha(bytes));
    await store.putFile(key, path.join(dir, "f"), sha(bytes), bytes.length);
    expect(sent[0]).toMatchObject({ name: "PutObjectCommand", input: { Bucket: "bucket", Key: `model-artifacts/${key}`, ContentLength: bytes.length, ChecksumSHA256: Buffer.from(sha(bytes), "hex").toString("base64") } });
    await expect(store.putFile("sha256/xyz", path.join(dir, "f"), sha(bytes), 1)).rejects.toThrow(/invalid artifact key/);
  });

  it("no store configured means none (uploads are refused)", () => {
    expect(artifactStoreFromEnv({})).toBeNull();
    // compose passes the variables through empty when unset: still none
    expect(artifactStoreFromEnv({ REGULAIT_MODEL_ARTIFACT_DIR: "", REGULAIT_MODEL_ARTIFACT_S3_BUCKET: "", REGULAIT_MODEL_ARTIFACT_S3_REGION: "" })).toBeNull();
    expect(artifactStoreFromEnv({ REGULAIT_MODEL_ARTIFACT_DIR: "/x" })?.kind).toBe("filesystem");
    expect(artifactStoreFromEnv({ REGULAIT_MODEL_ARTIFACT_S3_BUCKET: "b" })?.kind).toBe("s3");
  });
});

describe("B5-M upload helpers", () => {
  it("the bounded stream writes nothing past the limit and drains the rest", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "b5m-bound-"));
    let hashed = 0;
    const over = await streamBounded(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), path.join(dir, "a"), 10, (c) => (hashed += c.length));
    expect(over).toBe(true);
    expect(hashed).toBe(6);
    expect((await stat(path.join(dir, "a"))).size).toBe(6);
    const fits = await streamBounded(Readable.from([Buffer.from("abc"), Buffer.from("def")]), path.join(dir, "b"), 6, () => undefined);
    expect(fits).toBe(false);
    expect(await readFile(path.join(dir, "b"), "utf8")).toBe("abcdef");
  });

  it("a display name never carries a path or control characters", () => {
    expect(displayFilename("../../etc/model.safetensors")).toBe("model.safetensors");
    expect(displayFilename("C:\\models\\x.pt")).toBe("x.pt");
    expect(displayFilename("a\u0000b\nc.pkl")).toBe("a?b?c.pkl");
    expect(displayFilename(undefined)).toBe("artifact");
  });
});
