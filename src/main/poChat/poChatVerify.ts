/**
 * O "VERIFICAR DE VERDADE" do "Fala, PO": depois da resposta rápida, o PO
 * confere no projeto com o MESMO modo do PO com ferramentas do prompt 2
 * (po/poAgentQuery.ts: permissão `auto`, git de escrita bloqueado, teto de
 * turnos). Aqui ficam as peças sem SDK: a TRAVA de código de quando há agente
 * rodando no projeto (só leitura de arquivo e git de leitura — nada de teste,
 * build ou escrita), o pedido, a leitura da resposta e o teto de tempo.
 */
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk'
import type { PoChatMessage, PoChatOption, PoChatSource } from '../../shared/poChat'
import { refsOf, type PoChatContext } from './poChatModel'

export const VERIFY_MIN_MINUTES = 1
export const VERIFY_MAX_MINUTES = 15

/** O teto da verificação: o dobro do que o PO avisou, entre 3 e 15 min. */
export function verifyTimeoutMs(minutes: number): number {
  const m = Math.min(VERIFY_MAX_MINUTES, Math.max(VERIFY_MIN_MINUTES, Math.round(minutes || 5)))
  return Math.min(VERIFY_MAX_MINUTES, Math.max(3, m * 2)) * 60_000
}

/** git só de leitura, sem encadear nada (`;`, `&&`, `|`, redirecionamento, subshell). */
const GIT_READ = /^\s*git\s+(?:-C\s+\S+\s+)?(status|log|diff|show|blame|ls-files|rev-parse|branch|grep|shortlog|describe)\b[^;&|<>`$\n]*$/

export function quietCommandAllowed(command: string): boolean {
  return GIT_READ.test(command)
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS'])

/**
 * A trava de código (PreToolUse — vale antes de qualquer permissão): com um
 * agente rodando no projeto, só leitura de arquivo e git de leitura; o resto é
 * negado com o motivo. Sem agente rodando, tudo segue as travas do modo PO.
 */
export function verifyGuard(busy: () => boolean): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse' || !busy()) return {}
    const name = input.tool_name
    const command = typeof (input.tool_input as { command?: unknown })?.command === 'string' ? (input.tool_input as { command: string }).command : ''
    const ok = READ_TOOLS.has(name) || name.startsWith('mcp__app__') || (name === 'Bash' && quietCommandAllowed(command))
    if (ok && !WRITE_TOOLS.has(name)) return {}
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason:
          'Um agente está trabalhando neste projeto agora: a verificação só lê arquivos e o git (status, log, diff, show). Nada de teste, build, instalação nem escrita — confira pelo código.'
      }
    }
  }
}

/** O pedido da verificação: a pergunta, a resposta rápida a conferir e o contexto. */
export function verifyPrompt(input: { question: string; quick: PoChatMessage; ctx: PoChatContext; busy: boolean; contextText: string }): string {
  return [
    'Você é o PO deste projeto, no "Fala, PO". O usuário pediu para VERIFICAR DE VERDADE a resposta rápida abaixo, conferindo no projeto (arquivos, git, e o que mais for preciso).',
    input.busy
      ? 'Um agente está trabalhando neste projeto AGORA: só leia arquivos e use git de leitura (status, log, diff, show). Não rode teste, build nem instalação.'
      : 'Nenhum agente está rodando no projeto: você pode ler arquivos, usar o git e rodar o que for preciso para conferir (testes, por exemplo), sem modificar nada.',
    'Se um print de tela serviu de evidência, você pode anexá-lo ao cartão com app_anexar_print.',
    '',
    `PERGUNTA: ${input.question}`,
    `RESPOSTA RÁPIDA (a conferir): ${input.quick.text}`,
    input.quick.unconfirmed ? `O QUE NINGUÉM TINHA CONFIRMADO: ${input.quick.unconfirmed}` : '',
    '',
    '=== CONTEXTO (as referências K… são cartões; C… são conversas) ===',
    input.contextText,
    '',
    'Responda em português do Brasil, curto: a resposta verificada, citando [K…]/[C…] quando falar de um cartão ou conversa. Depois, linhas de controle (uma por linha, exatamente assim):',
    'EVIDENCIA: <um arquivo lido, comando rodado ou o que encontrou> (repita a linha para cada evidência)',
    'DIFERENCA: <a diferença em relação à resposta rápida, numa frase; "nenhuma" se ela estava certa>',
    'REABRIR: <K…> | <por quê, curto> (cartão marcado como concluído que NÃO está pronto)',
    'CRIAR: <C…> | <título do cartão que falta> (trabalho que falta e não tem cartão; C… é a conversa que deveria fazê-lo)'
  ]
    .filter((line) => line !== '')
    .join('\n')
}

const CONTROL = /^\s*(EVIDENCIA|EVIDÊNCIA|DIFERENCA|DIFERENÇA|REABRIR|CRIAR)\s*:\s*(.*)$/i
const REF = /\[(C\d+|K\d+)\]/g

export interface VerifyReply {
  text: string
  evidence: string[]
  difference: string | null
  sources: PoChatSource[]
  corrections: PoChatOption[]
}

/** A resposta verificada → texto, evidências, diferença e as correções que existem de verdade. */
export function parseVerifyReply(raw: string, ctx: PoChatContext): VerifyReply {
  const refs = refsOf(ctx)
  const evidence: string[] = []
  const corrections: PoChatOption[] = []
  let difference: string | null = null
  const body: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const m = CONTROL.exec(line)
    if (!m) {
      body.push(line)
      continue
    }
    const key = m[1].toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    const value = m[2].trim()
    if (key === 'EVIDENCIA' && value) evidence.push(value)
    else if (key === 'DIFERENCA') difference = value && !/^nenhuma\.?$/i.test(value) ? value : null
    else {
      const [ref, ...rest] = value.split('|')
      const what = rest.join('|').trim()
      const r = ref.trim().toUpperCase()
      if (key === 'REABRIR' && refs.cards.has(r)) {
        const card = refs.cards.get(r)!
        corrections.push({ kind: 'corrigir', action: 'reabrir', cardId: card.id, conversationId: card.conversationId, title: card.title, reason: what || 'não está pronto' })
      } else if (key === 'CRIAR' && refs.conversations.has(r) && what) {
        const conv = refs.conversations.get(r)!
        corrections.push({ kind: 'corrigir', action: 'criar', conversationId: conv.id, conversationTitle: conv.title, title: what.slice(0, 200), reason: 'o PO verificou que falta' })
      }
    }
  }
  const cited = new Set<string>()
  for (const m of body.join('\n').matchAll(REF)) cited.add(m[1])
  const sources: PoChatSource[] = []
  for (const ref of cited) {
    const conv = refs.conversations.get(ref)
    if (conv) sources.push({ kind: 'conversa', conversationId: conv.id, title: conv.title, at: conv.lastAt })
    const card = refs.cards.get(ref)
    if (card) sources.push({ kind: 'card', cardId: card.id, conversationId: card.conversationId, title: card.title, thumbUrl: card.thumbUrl })
  }
  const text = body.join('\n').replace(REF, '').replace(/[ \t]+([.,;:!?)])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim()
  return { text: text || '(a verificação não trouxe texto)', evidence, difference, sources, corrections }
}
