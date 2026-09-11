import { normalize } from 'node:path'
// Caminho relativo, não o alias `@shared`: o build do main não resolve o alias
// (só o renderer resolve), e o typecheck passa mesmo assim — o erro só aparece
// no `npm run build`.
import { isDownloadableFile, parseDownloads, type ChatEvent } from '../shared/ipc'

/**
 * What the agent is allowed to hand to the user as a download.
 *
 * There are two ways a file becomes downloadable, and they are the same two on
 * the phone bridge and on the desktop:
 *
 *  - a `Write` whose `file_path` has a deliverable extension (apk, zip, pdf…);
 *  - any path the agent explicitly exposed with a `[[download:PATH]]` marker in
 *    its text (e.g. an APK that Gradle produced, which never went through
 *    `Write`).
 *
 * Everything else — source files, config, anything merely mentioned — stays
 * closed. Keeping the rule in one module is the point: the bridge and the
 * desktop handler drifting apart is how one of them silently becomes the loose
 * one.
 */

/**
 * Comparable form of a path. Windows paths are case-insensitive, so
 * `C:\Out\App.apk` and `c:\out\app.apk` are the same file; comparing them raw
 * would deny a legitimate download with no visible error.
 */
export function canonicalPath(p: string): string {
  const n = normalize(p)
  return process.platform === 'win32' ? n.toLowerCase() : n
}

/** Deliverables exposed by a single live event. */
export function downloadablesFromEvent(event: ChatEvent): string[] {
  if (event.kind === 'tool-use' && event.name === 'Write') {
    const input = (event.input ?? {}) as Record<string, unknown>
    const p = input.file_path
    return typeof p === 'string' && p && isDownloadableFile(p) ? [p] : []
  }
  // Só o texto FINAL. O streaming emite `assistant-text` a cada token com o
  // texto ACUMULADO até ali, então varrer os parciais custaria uma passada de
  // regex sobre a resposta inteira por token — quadrático no tamanho dela, e
  // sem ganho: o marcador só vale quando a mensagem termina, e o evento final
  // traz o texto completo.
  if (event.kind === 'assistant-text' && event.final) return parseDownloads(event.text).paths
  return []
}

/**
 * Deliverables exposed by persisted conversation messages. Same two rules as
 * `downloadablesFromEvent`, applied to the stored shape — this is what keeps a
 * download working after the app restarts and the conversation is read back
 * from disk, instead of only during the session that produced the file.
 */
export function downloadablesFromMessages(messages: readonly unknown[]): string[] {
  const out: string[] = []
  for (const raw of messages) {
    const m = raw as Record<string, unknown> | null
    if (!m) continue
    if (m.kind === 'tool-use' && String(m.name) === 'Write') {
      const input = (m.input ?? {}) as Record<string, unknown>
      const p = input.file_path
      if (typeof p === 'string' && p && isDownloadableFile(p)) out.push(p)
    } else if (m.kind === 'assistant-text' && typeof m.text === 'string') {
      out.push(...parseDownloads(m.text).paths)
    }
  }
  return out
}

/** How long a persisted scan stays good. Only ever consulted on a miss. */
const PERSISTED_TTL_MS = 5_000

/**
 * The desktop side of the allowlist.
 *
 * Live events are recorded as they are teed, which covers everything produced
 * in this run. A path the live set doesn't know is not refused outright: it may
 * come from a conversation restored from disk, so the persisted messages are
 * scanned once and cached briefly. The scan is lazy on purpose — it costs a
 * database read, and it only ever happens when the user actually clicks a
 * download whose file predates this session.
 */
export class DownloadAllowlist {
  private readonly live = new Set<string>()
  private persisted = new Set<string>()
  private persistedAt = 0

  /** Feed from the single event tee, so the bridge being off changes nothing. */
  track(event: ChatEvent): void {
    for (const p of downloadablesFromEvent(event)) this.live.add(canonicalPath(p))
  }

  /**
   * `loadPersisted` returns the stored message arrays. It is a callback rather
   * than a repository so this module stays testable without a database, and so
   * a storage failure here can be treated as "no extra paths" instead of taking
   * the download handler down with it.
   */
  async allows(path: string, loadPersisted: () => Promise<readonly unknown[][]>): Promise<boolean> {
    if (!path) return false
    const wanted = canonicalPath(path)
    if (this.live.has(wanted)) return true

    const now = Date.now()
    if (now - this.persistedAt > PERSISTED_TTL_MS) {
      try {
        const conversations = await loadPersisted()
        const fresh = new Set<string>()
        for (const messages of conversations) {
          for (const p of downloadablesFromMessages(messages)) fresh.add(canonicalPath(p))
        }
        this.persisted = fresh
      } catch {
        // Storage unavailable: fall back to what the live set knows rather than
        // authorizing everything. A denied download is recoverable; a wrong
        // allow is the thing this class exists to prevent.
        this.persisted = new Set()
      }
      this.persistedAt = now
    }
    return this.persisted.has(wanted)
  }
}
