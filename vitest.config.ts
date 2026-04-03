import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    poolOptions: {
      workers: {
        main: "./src/index.tsx",
        wrangler: { configPath: "./wrangler.live.jsonc" },
        miniflare: {
          bindings: {
            JWT_SECRET: "test-jwt-secret-for-vitest",
          },
          d1Databases: {
            DB: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
          },
          r2Buckets: {
            IMAGES: "test-images-bucket",
          },
        },
      },
    },
  },
});
