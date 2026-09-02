import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          RELAY_ACCESS_TOKEN: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});
