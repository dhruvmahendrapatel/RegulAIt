import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Both test files share one Postgres database; parallel workers would race
    // on migrations and seed data.
    fileParallelism: false,
  },
});
