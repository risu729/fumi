import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      config: "./cloudflare.config.ts",
      remoteBindings: false,
      miniflare: { bindings: { FORWARD_TO: "synthetic-forward@gmail.com" } },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
