import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
/** Set E2E_BASE_URL to run the suite against a deployed URL instead of a local preview. */
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: external ?? `http://localhost:${PORT}`,
    trace: 'off',
    // Software WebGL in headless CI.
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'phone-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: external
    ? undefined
    : {
        command: `npm run preview -- --port ${PORT}`,
        port: PORT,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
