/** Electron prefixes rejected invoke() errors with channel/remote-method detail.
 * Keep recovery UI user-facing and never echo transport internals. */
export function ipcErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message.trim() : ''
  if (!raw) return fallback
  const storageMarker = raw.lastIndexOf('StorageError:')
  if (storageMarker >= 0) return raw.slice(storageMarker + 'StorageError:'.length).trim()
  const errorMarker = raw.lastIndexOf('Error:')
  if (raw.startsWith('Error invoking remote method') && errorMarker >= 0) {
    return raw.slice(errorMarker + 'Error:'.length).trim()
  }
  return raw
}
