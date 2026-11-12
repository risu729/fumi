import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      config: "./cloudflare.config.ts",
      remoteBindings: false,
      miniflare: {
        workerLoaders: { PDF_LOADER: {} },
        // Never resolve an operator-configured remote owner during unit tests.
        // Native named-export RPC wiring is exercised by test/artifact.mjs.
        serviceBindings: { ROUTING_DISPATCH_RPC: async () => new Response(null, { status: 503 }) },
        bindings: {
          FORWARD_TO: "synthetic-forward@gmail.com",
          ACCESS_ISSUER: "https://synthetic.cloudflareaccess.com",
          ACCESS_AUDIENCE: "synthetic-app",
          API_ORIGIN: "https://mail.example.invalid",
          MAIL_GRANTS: "{}",
          WEBHOOK_ORIGINS: "[]",
          TEST_MIGRATIONS: await readD1Migrations("migrations"),
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // MIME/Gmail files allocate bounded raw buffers and isolated D1 runtimes.
    // Avoid competing file runtimes while retaining every case and its deadline.
    fileParallelism: false,
  },
});
