import { StorageError } from '../persistence/types'
import type { MemoryProposeInput } from './memoryModel'
import {
  derivedSecretName,
  isSecretName,
  redactSecrets,
  scanSecrets,
  secretPlaceholder,
  type SecretMatch
} from './secretScan'

/**
 * Last gate before `MemoryService.propose` enqueues anything: a plaintext
 * credential must never reach the proposal queue, the `.md` body or MEMORY.md.
 * Redaction is therefore unconditional — the vault only decides whether the
 * value survives *somewhere*, never whether the text is cleaned.
 */

/** Minimal slice of SecretVault so tests inject a fake. */
export interface SecretSink {
  enabled(): boolean
  put(name: string, value: string): Promise<unknown>
}
export interface ExplicitSecret { name: string; value: string }
export interface SanitizedProposal {
  input: MemoryProposeInput
  stored: string[]
  skipped: SecretMatch[]
  notes: string[]
}

/** Fields that end up in the Markdown/index — the only ones we scan and redact. */
const FIELDS = ['title', 'hook', 'body'] as const

function invalid(message: string): StorageError {
  return new StorageError('INVALID_PERSISTED_DATA', message)
}

interface Assignment {
  value: string
  name: string
  kind: string
}

/**
 * Explicit secrets first (their name wins over a derived one) and always
 * assigned even when the scanner missed the value — the model asserting "this
 * is a credential" is stronger evidence than a heuristic. Then the scanner
 * output, field by field, so `stored` follows first appearance.
 */
function planAssignments(
  input: MemoryProposeInput,
  explicit: readonly ExplicitSecret[]
): Assignment[] {
  const assignments: Assignment[] = []
  const byValue = new Map<string, Assignment>()
  const takenNames = new Set<string>()

  for (const secret of explicit) {
    if (!isSecretName(secret?.name)) throw invalid('Nome de segredo inválido para o cofre.')
    if (typeof secret.value !== 'string' || !secret.value) throw invalid('Valor de segredo vazio.')
    // Same value declared twice is one vault entry: the first name wins.
    if (byValue.has(secret.value)) continue
    if (takenNames.has(secret.name)) throw invalid(`Nome de segredo repetido: ${secret.name}.`)
    const assignment = { value: secret.value, name: secret.name, kind: 'explicit' }
    takenNames.add(secret.name)
    byValue.set(secret.value, assignment)
    assignments.push(assignment)
  }

  let counter = 0
  for (const field of FIELDS) {
    const text = input[field]
    if (typeof text !== 'string' || !text) continue
    for (const match of scanSecrets(text)) {
      if (byValue.has(match.value)) continue
      let name = derivedSecretName(input.relPath, ++counter)
      while (takenNames.has(name)) name = derivedSecretName(input.relPath, ++counter)
      const assignment = { value: match.value, name, kind: match.kind }
      takenNames.add(name)
      byValue.set(match.value, assignment)
      assignments.push(assignment)
    }
  }
  return assignments
}

export async function sanitizeProposal(
  input: MemoryProposeInput,
  options: { vault: SecretSink | null; explicit?: readonly ExplicitSecret[] }
): Promise<SanitizedProposal> {
  const assignments = planAssignments(input, options.explicit ?? [])
  // Nothing to hide: return the caller's input untouched and never wake the vault.
  if (!assignments.length) return { input, stored: [], skipped: [], notes: [] }

  const vault = options.vault
  const stored: string[] = []
  const skipped: SecretMatch[] = []
  for (const assignment of assignments) {
    // Checked per value, immediately before its own put — the switch can flip
    // while an earlier put is awaiting. This is the outer gate only: SecretVault
    // re-checks inside its queue and again before writing, which is what covers
    // a flip that lands after this call already passed.
    // The placeholder, not the value, goes into `skipped`: this object is
    // logged and handed back to the model.
    if (!vault || !vault.enabled()) {
      skipped.push({ value: secretPlaceholder(assignment.name), kind: assignment.kind })
      continue
    }
    // A rejected put must abort the whole proposal — enqueuing a body that
    // points at a vault entry that was never written silently loses the value.
    await vault.put(assignment.name, assignment.value)
    stored.push(assignment.name)
  }

  const map = new Map(assignments.map((assignment) => [assignment.value, assignment.name]))
  const sanitized: MemoryProposeInput = { ...input }
  for (const field of FIELDS) {
    const text = input[field]
    if (typeof text === 'string' && text) sanitized[field] = redactSecrets(text, map)
  }

  const notes: string[] = []
  if (stored.length) {
    notes.push(
      `${stored.length} valor(es) sensível(is) foram movidos para o cofre e substituídos por ` +
        `{{secret:nome}} no texto: ${stored.join(', ')}.`
    )
  }
  if (skipped.length) {
    const names = skipped.map((match) => match.value).join(', ')
    notes.push(
      'Valores sensíveis foram removidos do texto mas NÃO foram salvos: o cofre de segredos ' +
        `está desligado em Configurações. Placeholders sem valor no cofre: ${names}.`
    )
  }
  return { input: sanitized, stored, skipped, notes }
}
