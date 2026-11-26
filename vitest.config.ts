import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Many tests start real processes (PowerShell/sh for Bash and hooks, MCP servers). On a busy
    // Windows machine PowerShell alone can take several seconds to start, so vitest's default
    // 5s limit made those tests fail at random.
    testTimeout: 30_000,
  },
});
