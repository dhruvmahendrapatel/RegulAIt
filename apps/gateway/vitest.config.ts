import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test file shares one Postgres database; parallel workers would
    // race on migrations and seed data.
    fileParallelism: false,
  },
});
