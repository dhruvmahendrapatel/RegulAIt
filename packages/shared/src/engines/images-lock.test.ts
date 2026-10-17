/**
 * ENG-IMG — the manifest takes each engine image's digests from the lock (engines/images.lock.json, through the
 * generated images-lock.ts), so a recorded publish is the only way an engine gets an image, and an unpublished one
 * places nothing.
 */
import { describe, expect, it } from "vitest";
import { ENGINE_IMAGES_LOCK } from "./images-lock.js";
import { ENGINE_MANIFEST } from "./manifest.js";

describe("ENG-IMG: the manifest's image fields are the lock's", () => {
  it("imageDigest is the registry digest, taskImage the image id; both null together until a publish", () => {
    for (const id of ["promptfoo", "modelscan", "garak"] as const) {
      const lock = ENGINE_IMAGES_LOCK[id];
      expect(ENGINE_MANIFEST[id].imageDigest).toBe(lock.manifestDigest);
      expect(ENGINE_MANIFEST[id].taskImage).toBe(lock.imageId);
      expect(ENGINE_MANIFEST[id].imageDigest === null).toBe(ENGINE_MANIFEST[id].taskImage === null);
      if (lock.manifestDigest !== null) expect(ENGINE_MANIFEST[id].generation).toBeGreaterThan(lock.publishGeneration);
    }
  });
});
