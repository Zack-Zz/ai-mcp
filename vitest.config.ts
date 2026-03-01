import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@ai-mcp/shared': resolve(rootDir, 'packages/shared/src/index.ts'),
      '@ai-mcp/mcp-server': resolve(rootDir, 'packages/mcp-server/src/index.ts'),
      '@ai-mcp/mcp-client': resolve(rootDir, 'packages/mcp-client/src/index.ts')
    }
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      all: true,
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        '**/*.test.ts',
        '**/dist/**',
        '**/examples/**',
        '**/src/cli.ts',
        '**/src/index.ts',
        '**/src/types.ts',
        '**/mcp-server/src/transports/**',
        '**/mcp-client/src/transports/base.ts',
        '**/mcp-client/src/transports/stdio.ts'
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80
      }
    }
  }
});
