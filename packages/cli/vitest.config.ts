import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      '@velar/shared': path.resolve(__dirname, '../shared/src/index.ts'),
      '@velar/rules': path.resolve(__dirname, '../rules/src/index.ts'),
    },
  },
})
