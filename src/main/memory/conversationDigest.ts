/**
 * O resumo textual da conversa que o Haiku vê ao escolher memórias
 * (memorySelectionHaiku.ts): as mensagens do usuário e o TEXTO do assistente
 * principal, sem ferramentas, sem pensamento e sem subagentes.
 *
 * Quando não cabe tudo, as mais recentes têm prioridade: o assunto do turno
 * está no fim da conversa, não no começo. A saída sai em ordem cronológica.
 */

export type DigestRole = 'user' | 'assistant'

interface DigestEntry {
  role: DigestRole
  text: string
}

/** Teto de uma mensagem isolada: um despejo de log colado não pode, sozinho,
 *  ocupar o orçamento inteiro e empurrar o resto da conversa para fora. */
export const DIGEST_ENTRY_MAX_CHARS = 12_000
/** Quanto a conversa guarda em memória, no total. Acima disso, as mais antigas
 *  saem — nunca seriam lidas, o orçamento da pergunta é menor que isto. */
export const DIGEST_STORE_MAX_CHARS = 600_000
/** Abaixo disto, a sobra do orçamento não vira um trecho cortado: não informa. */
const DIGEST_MIN_FRAGMENT_CHARS = 200

const LABEL: Record<DigestRole, string> = { user: 'Usuário', assistant: 'Assistente' }

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function line(entry: DigestEntry): string {
  return `${LABEL[entry.role]}: ${entry.text}`
}

export class ConversationDigest {
  private entries: DigestEntry[] = []
  private stored = 0

  /** Registra uma mensagem. Texto vazio é ignorado. */
  add(role: DigestRole, text: string): void {
    const clean = String(text ?? '').trim()
    if (!clean) return
    const entry = { role, text: clip(clean, DIGEST_ENTRY_MAX_CHARS) }
    this.entries.push(entry)
    this.stored += entry.text.length
    while (this.stored > DIGEST_STORE_MAX_CHARS && this.entries.length > 1) {
      this.stored -= this.entries.shift()!.text.length
    }
  }

  /**
   * Põe ANTES das atuais as mensagens de uma conversa retomada (conversationSeed.ts).
   * Se a gravação já trouxer mensagens deste processo (o primeiro envio saiu
   * antes da carga terminar), o trecho repetido no fim dela fica de fora.
   */
  prepend(seed: readonly { role: DigestRole; text: string }[]): void {
    const older: DigestEntry[] = []
    for (const item of seed) {
      const clean = String(item?.text ?? '').trim()
      if (clean) older.push({ role: item.role, text: clip(clean, DIGEST_ENTRY_MAX_CHARS) })
    }
    if (older.length === 0) return
    const same = (a: DigestEntry, b: DigestEntry): boolean => a.role === b.role && a.text === b.text
    // O menor corte em que o fim da gravação é o começo do que já está aqui.
    let cut = older.length
    for (let p = Math.max(0, older.length - this.entries.length); p < older.length; p++) {
      if (older.slice(p).every((entry, i) => same(entry, this.entries[i]))) {
        cut = p
        break
      }
    }
    this.entries = [...older.slice(0, cut), ...this.entries]
    this.stored = this.entries.reduce((sum, entry) => sum + entry.text.length, 0)
    while (this.stored > DIGEST_STORE_MAX_CHARS && this.entries.length > 1) {
      this.stored -= this.entries.shift()!.text.length
    }
  }

  /**
   * A conversa em até `maxChars` caracteres. Junta das mais recentes para as
   * mais antigas enquanto couber; a primeira que não cabe entra cortada (se a
   * sobra ainda diz alguma coisa) e o resto fica de fora.
   */
  render(maxChars: number): string {
    const budget = Math.floor(maxChars)
    if (!(budget > 0) || this.entries.length === 0) return ''
    const kept: string[] = []
    let used = 0
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const text = line(this.entries[i])
      const cost = text.length + (kept.length ? 2 : 0)
      if (used + cost <= budget) {
        kept.push(text)
        used += cost
        continue
      }
      const room = budget - used - (kept.length ? 2 : 0)
      if (room >= DIGEST_MIN_FRAGMENT_CHARS) kept.push(clip(text, room))
      break
    }
    return kept.reverse().join('\n\n')
  }

  get size(): number {
    return this.entries.length
  }

  reset(): void {
    this.entries = []
    this.stored = 0
  }
}
