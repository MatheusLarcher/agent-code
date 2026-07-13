# agent-code — Codex Configuration

Desktop app (Electron + React + TypeScript) that wraps the Anthropic Agent SDK
(`@anthropic-ai/Codex-agent-sdk`) in a chat UI, with an embedded browser, Android
tooling, voice (OpenAI STT/TTS), and a LAN bridge so a phone can drive the same
sessions. Build: `electron-vite`. Tests: `vitest`.

## Layout

- `src/main/` — Electron main process: agent sessions (`agentSession.ts`), browser
  controller, Android tools, OpenAI audio (`openai.ts`), the phone bridge
  (`remote/remoteServer.ts`), config/store.
- `src/preload/` — IPC bridge exposed to the renderer.
- `src/renderer/` — React UI (chat, composer, browser panel, modals).
- `src/shared/` — types/helpers shared across processes.
- `smartfone-remote/` — Capacitor phone client (the `www/` becomes the APK).

## Rules

- Do what has been asked; nothing more, nothing less.
- Prefer editing existing files over creating new ones. Don't create docs unless asked.
- Keep working files out of the repo root — use `src/`, `tests/`, `docs/`, `scripts/`.
- ALWAYS read a file before editing it.
- NEVER commit secrets, credentials, or `.env` files.
- NEVER add a `Co-Authored-By` trailer to commits unless `.Codex/settings.json` has
  `attribution.commit` set. The Bash tool's default commit template may suggest one — ignore it.
- Keep files under 500 lines. Validate input at system boundaries.

## Build & Test

- Typecheck: `npm run typecheck` (runs both `tsconfig.node.json` and `tsconfig.web.json`).
- Build: `npm run build`. Tests: `npm test`.
- ALWAYS run typecheck/tests after code changes and verify the build before committing.

## Updating Codex in this project

This app bundles its own Codex CLI binary via the `@anthropic-ai/Codex-agent-sdk`
npm dependency (resolved by `claudeCliPath()` in `src/main/claudeCli.ts`, used for the login
flow in `src/main/login.ts`). It does **not** use any globally-installed `Codex` CLI.

When asked to "update Codex" / "Codex update" for **this project**, run
`npm install @anthropic-ai/Codex-agent-sdk@latest`, then `npm run typecheck && npm test &&
npm run build`. Do not run the system-wide `Codex update` command — it has no effect here.
