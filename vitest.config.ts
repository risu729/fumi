import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      config: "./cloudflare.config.ts",
      remoteBindings: false,
      miniflare: {
        bindings: {
          FORWARD_TO: "synthetic-forward@gmail.com",
          TEST_MIGRATIONS: await readD1Migrations("migrations"),
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
