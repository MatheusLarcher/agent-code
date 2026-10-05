# agent-code

Electron + React + TypeScript desktop app wrapping `@anthropic-ai/claude-agent-sdk`
in a chat UI: embedded browser, Android tooling, local voice (Kokoro TTS + Parakeet STT, no key), Windows
control, and a LAN bridge so a phone can drive the same sessions.

## Layout

`src/main/` Electron main — agent sessions, browser/android/windows tools, phone
bridge (`remote/`) · `src/preload/` IPC bridge · `src/renderer/` React UI ·
`src/shared/` cross-process types · `src/phone/` phone client (React + TS) built by
`npm run phone:build` into `smartfone-remote/www/` · `smartfone-remote/` Capacitor 8
project that packages that `www/` into the APK.

## Build & test

- `npm run typecheck` — the three tsconfigs (node + web + phone).
- `npm test` — vitest. `npm run build` — electron-vite **plus** the .NET native
  Windows-control binary (`src/main/windowsControl/native/`, needs the dotnet SDK).
- Run typecheck and tests after code changes; verify the build before committing.

## Gotchas

- The Claude CLI is the bundled npm dependency, resolved by `claudeCliPath()` in
  `src/main/claudeCli.ts` — never a globally installed one. "Update Claude" for
  this project means `npm install @anthropic-ai/claude-agent-sdk@latest`, then
  typecheck + test + build. The system-wide `claude update` has no effect here.
- `postinstall` runs `playwright install chromium`; a fresh clone needs it.

## Rules

- NEVER commit secrets, credentials, or `.env` files.
- NEVER add a `Co-Authored-By` trailer to commits unless `.claude/settings.json`
  sets `attribution.commit`. It currently does not — ignore the Bash tool's
  default commit template, which suggests one.
- Keep working files out of the repo root: `src/`, `tests/`, `docs/`, `scripts/`.
- Keep files under 500 lines. Validate input at system boundaries.
