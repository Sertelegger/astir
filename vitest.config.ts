import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // The artifact tests build and spawn the real dist output; give them room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
