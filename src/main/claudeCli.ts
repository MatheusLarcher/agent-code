// Resolves the bundled Claude Code native CLI (claude.exe on Windows, `claude`
// elsewhere) that the Agent SDK ships as a per-platform optional dependency
// (@anthropic-ai/claude-agent-sdk-<platform>-<arch>). We spawn it directly for the
// auth flow — `claude auth login` / `claude auth status` — which the headless SDK
// query() loop can't drive. externalizeDepsPlugin keeps these packages as runtime
// node_modules requires, so require.resolve finds the binary at runtime too.
import { createRequire } from 'node:module'

let cached = ''

/** Absolute path to the bundled Claude Code CLI binary for this platform/arch. */
export function claudeCliPath(): string {
  if (cached) return cached
  const require = createRequire(import.meta.url)
  const plat = process.platform
  const arch = process.arch
  const bin = plat === 'win32' ? 'claude.exe' : 'claude'
  const pkgs = [`@anthropic-ai/claude-agent-sdk-${plat}-${arch}`]
  // Linux additionally ships a musl-linked variant under its own package name.
  if (plat === 'linux') pkgs.push(`@anthropic-ai/claude-agent-sdk-${plat}-${arch}-musl`)
  for (const pkg of pkgs) {
    try {
      cached = require.resolve(`${pkg}/${bin}`)
      return cached
    } catch {
      /* try the next candidate package */
    }
  }
  throw new Error(`Claude CLI binary not found for ${plat}-${arch} in node_modules`)
}
