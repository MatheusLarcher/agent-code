import type { AppRestartCoordinator } from './appRestart'

// Configured by main before registering IPC. Undefined in unit-test sessions.
export let appRestart: AppRestartCoordinator | undefined
export function configureAppRestart(coordinator: AppRestartCoordinator): void { appRestart = coordinator }
