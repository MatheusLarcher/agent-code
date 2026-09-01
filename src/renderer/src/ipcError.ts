/** The storage error code carried across IPC, or `null` for any other failure.
 * Lets a caller react to a specific class of failure (e.g. rebase on
 * `REVISION_CONFLICT`) instead of matching on the human-facing message. */
export function ipcStorageErrorCode(error: unknown): string | null {
  const raw = error instanceof Error ? error.message : ''
  const match = /\[agent-code-storage-error:([A-Z_]+):(?:retryable|fatal)\]/.exec(raw)
  return match ? match[1] : null
}

/** Electron prefixes rejected invoke() errors with channel/remote-method detail.
 * Keep recovery UI user-facing and never echo transport internals. */
export function ipcErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message.trim() : ''
  if (!raw) return fallback
  const storageMarker = raw.lastIndexOf('StorageError:')
  if (storageMarker >= 0) {
    return raw
      .slice(storageMarker + 'StorageError:'.length)
      .trim()
      .replace(/^\[agent-code-storage-error:[A-Z_]+:(?:retryable|fatal)\]\s*/, '')
  }
  const errorMarker = raw.lastIndexOf('Error:')
  if (raw.startsWith('Error invoking remote method') && errorMarker >= 0) {
    return raw.slice(errorMarker + 'Error:'.length).trim()
  }
  return raw
}
