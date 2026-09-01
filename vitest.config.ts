import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  test: {
    environment: 'jsdom',
    // Mounting the whole app dozens of times under the parallel suite can take
    // well over the 5s default while still passing in isolation.
    testTimeout: 20_000,
    globals: true,
    include: ['src/**/*.test.{ts,tsx}']
  }
})
