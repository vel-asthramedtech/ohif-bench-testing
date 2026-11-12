// playwright.config.js
const headed = !!process.env.HEADED;

// Software WebGL (SwiftShader) is only needed for headless runs.
// In headed mode the browser uses your real GPU, which matches what you see in a normal browser.
const softwareGl = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
];

module.exports = {
  timeout: 5 * 60 * 1000, // per test; each step inside has its own shorter cap
  workers: 1,             // one test at a time so results aren't skewed
  retries: 0,
  reporter: 'list',
  use: {
    headless: !headed,
    viewport: { width: 1600, height: 900 },
    launchOptions: {
      args: [
        '--enable-precise-memory-info',
        '--ignore-gpu-blocklist',
        ...(headed ? [] : softwareGl),
      ],
    },
  },
};