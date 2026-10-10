import { existsSync, readFileSync, readlinkSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'

/** Listing and content digest of skill folders, shared by skillManager and skillKits. */

export const VALID_SKILL_DIRECTORY = /^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u

/** The skill folders of `root` (each with a SKILL.md), sorted; [] when unreadable. */
export function skillNames(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => VALID_SKILL_DIRECTORY.test(name))
      .filter((name) => !name.endsWith('.agent-code-new'))
      .filter((name) => existsSync(join(root, name, 'SKILL.md')))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/** Content digest of a whole tree (names, files, link targets); '' when unreadable. */
export function directoryDigest(root: string): string {
  const hash = createHash('sha256')
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const key = relative(root, path).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        hash.update(`d:${key}\0`)
        visit(path)
      } else if (entry.isSymbolicLink()) {
        hash.update(`l:${key}:${readlinkSync(path)}\0`)
      } else if (entry.isFile()) {
        hash.update(`f:${key}:`)
        hash.update(readFileSync(path))
        hash.update('\0')
      }
    }
  }
  try {
    visit(root)
    return hash.digest('hex')
  } catch {
    return ''
  }
}
