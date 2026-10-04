/**
 * Os avisos dos chamados do agente no main (req-aviso-chamado). O handler da
 * ferramenta app_chamar_usuario avisa aqui (officeCallRuntime.ts) e daqui saem:
 *   - a notificação do Windows (o agente, o projeto e o título do mockup; o
 *     clique traz o app e abre o Escritório na TV) — salvo se o usuário já está
 *     olhando a sala de reunião (`watching`, dito pela interface);
 *   - os avisos da ponte do celular (office-call / office-call-resolved).
 * O que só a interface sabe (abriu na TV, respondeu, a conversa saiu, o arquivo
 * sumiu, o título da conversa) chega por `state` (shared/officeCall.ts).
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { OfficeCallEnd, OfficeCallEvent, OfficeCallResolved, OfficeCallsState } from '../shared/officeCall'
import type { OfficeCallNotice } from './officeCallRuntime'

export interface CallCenterDeps {
  bridge: { call(e: OfficeCallEvent): void; resolved(r: OfficeCallResolved): void }
  /** Mostra a notificação; o clique chama `onClick`. */
  notify(e: OfficeCallEvent, onClick: () => void): void
  /** O clique na notificação: o app vem para a frente e a aba Escritório abre na TV. */
  open(e: OfficeCallEvent): void
  readHead?: (file: string) => Promise<string>
}

/** Quanto do HTML ler para achar o <title>. */
const HEAD_BYTES = 64 * 1024

async function readHead(file: string): Promise<string> {
  const h = await fs.open(file, 'r')
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await h.read(buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await h.close()
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' }

/** O <title> do HTML (sem tags, entidades básicas resolvidas, até 120 caracteres); null sem título. */
export function htmlTitle(head: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)
  const t = m?.[1].replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, k: string) => ENTITIES[k] ?? '').replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 120) : null
}

const ENDS: ReadonlySet<OfficeCallEnd> = new Set(['aberto', 'respondido', 'cancelado'])
const str = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** O estado vindo do renderer, validado (null se não presta). */
export function parseCallsState(raw: unknown): OfficeCallsState | null {
  const r = raw as Partial<OfficeCallsState> | null
  if (!r || typeof r !== 'object' || !Array.isArray(r.open) || !Array.isArray(r.ended) || typeof r.watching !== 'boolean') return null
  const titles: Record<string, string> = {}
  for (const [k, v] of Object.entries(r.titles && typeof r.titles === 'object' ? r.titles : {})) if (str(k, 200) && str(v, 500)) titles[k] = v
  return {
    open: r.open.filter((id): id is string => str(id, 200)).slice(0, 200),
    ended: r.ended.filter((e): e is OfficeCallResolved => !!e && str(e.id, 200) && ENDS.has(e.motivo)).slice(0, 200),
    watching: r.watching,
    titles
  }
}

export class OfficeCallCenter {
  private watching = false
  private titles: Record<string, string> = {}

  constructor(private readonly deps: CallCenterDeps) {}

  /** Um agente chamou: a ponte e (se ninguém está olhando a sala) a notificação. */
  async add(n: OfficeCallNotice): Promise<OfficeCallEvent> {
    const head = await (this.deps.readHead ?? readHead)(n.path).catch(() => '')
    const e: OfficeCallEvent = {
      id: n.id,
      convId: n.convId,
      agente: this.titles[n.convId] || 'Agente',
      projeto: path.basename(n.cwd) || n.cwd,
      arquivo: path.relative(n.cwd, n.path).split(path.sep).join('/'),
      titulo: htmlTitle(head) ?? path.basename(n.path),
      ...(n.mensagem ? { mensagem: n.mensagem } : {}),
      at: n.at
    }
    this.deps.bridge.call(e)
    if (!this.watching) this.deps.notify(e, () => this.deps.open(e))
    return e
  }

  /** O que a interface sabe: quem está olhando, os títulos e os chamados que acabaram. */
  state(s: OfficeCallsState): void {
    this.watching = s.watching
    this.titles = s.titles
    for (const r of s.ended) this.deps.bridge.resolved(r)
  }
}
