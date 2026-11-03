import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.ts",
  outputDir: join(tmpdir(), `presentation-rehearsal-tests-${process.pid}`),
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
    permissions: ["microphone"],
  },
  webServer: {
    command: "node src/server.ts",
    url: "http://127.0.0.1:4173/deck.html",
    reuseExistingServer: true,
  },
});
