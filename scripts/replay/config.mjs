// O que o replay compara: 3 tarefas reais (simples) do agent-code × 2 lados × 2 rodadas (ROUNDS).
// Fonte: planejamento plano-20261008-2158 (cards requisito-replay e decisao-tarefas-replay).
import path from 'node:path'

export const REPO = 'C:/GitHub/agent-code'
/** Tudo o que é descartável fica fora do checkout do usuário (e fora do C:, que está cheio). */
export const ROOT = 'D:/agent-code-replay'
export const DATE = '2026-10-09'
/** Resultados (diffs, avaliações, notas) — ficam no repositório. */
export const OUT = path.join(REPO, 'docs', 'validation', `replay-${DATE}`)
/** Skills do usuário (o cache do app dele), copiadas para cada instância isolada. */
export const USER_SKILLS = 'D:/OneDrive/Documentos/agent-code/skills'

/**
 * Modelo/effort do Agent Manager nas rodadas (a implementação herda do Manager).
 * O Manager do usuário roda em Opus 5.5 `max`; em 09/10 11:02 o usuário escolheu
 * `xhigh` para o replay — em `max` cada rodada levava ~2,5 h e a tarefa 1 estourava o
 * teto de 2 h. Mesmo par nos dois lados.
 */
export const MANAGER = { model: 'claude-opus-5-5', effort: 'xhigh' }

export const SIDES = {
  // Hoje: os interruptores desligados (golden dos prompts 1 e 2 = comportamento anterior).
  hoje: { leituraGuiada: false, tiered: false },
  // Novo: o catálogo em níveis fica desligado também aqui — reprovado no teste de acerto
  // (docs/validation/teste-acerto-skills-2026-10-09.md). O interruptor das 7 fases saiu do app.
  novo: { leituraGuiada: true, tiered: false }
}

/** 2 rodadas por lado (12 execuções, como no card original) — escolha do usuário em 09/10 11:02. */
export const ROUNDS = 2
/**
 * Teto do trabalho do agente numa rodada (handoff + implementação): 10 min, regra do
 * usuário em 09/10 15:10 — passou de 10 min, a rodada é reprovada. A avaliação (~3 min)
 * vem depois e não conta.
 */
export const ROUND_TIMEOUT_MS = 10 * 60_000
/** Teto do planejamento (feito uma vez por tarefa, antes das rodadas). */
export const PLAN_TIMEOUT_MS = 20 * 60_000

/**
 * As tarefas. `plan` = de onde vem o plano congelado usado em todas as rodadas.
 * Em 09/10 13:03 o usuário pediu desafios mais simples (as três primeiras — 7f70725,
 * 910d1af, bd18a6a — levavam mais de 2 h por rodada): commits pequenos, com teste, cujo
 * pedido original está no banco do app e foi resolvido em poucos minutos na época.
 */
export const TASKS = {
  s1: {
    reference: 'e2f744a',
    titulo: 'botão de revisão de código termina com commit',
    origem: 'pedido direto, conversa cmunihwiw4cygx (30/09 04:00Z); resolvido em ~2 min',
    plan: { kind: 'frozen', slugHint: 'replay-s1' }
  },
  s2: {
    reference: '1528e6e',
    titulo: 'Quadro ordenado pela data de modificação',
    origem: 'pedido direto, conversa cmuc0qwdomwp3t (22/09 13:52Z); resolvido em ~4 min',
    plan: { kind: 'frozen', slugHint: 'replay-s2' }
  },
  s3: {
    reference: '974d348',
    titulo: 'consumo da conta atualiza a cada 1 min e zera quando a janela reseta',
    origem: 'pedido direto, conversa cmtmvv3cgn9ls5 (04/09 11:46Z); resolvido em ~9 min',
    plan: { kind: 'frozen', slugHint: 'replay-s3' }
  },
  /**
   * Validação da autonomia do handoff (plano-20261010-0616, etapa `validar`): o NOVO
   * build refaz uma conversa de handoff real que perguntou ao usuário. Sessão base
   * 3708b226 (06/10 14:17–16:21Z): 1 AskUserQuestion, 1 espera de 7 min, 1 turno
   * terminado em pergunta. A entrega foram 3 commits seguidos (794f767, 63a4ae5,
   * 526d549, 3 min antes do fim da sessão): referência = a faixa `parent..reference`.
   * O plano é o REAL da sessão (cópia de plano-20261006-1026, sem o _handoff): o
   * Manager só escreve o handoff com as regras novas — a comparação com a base usa a
   * mesma entrada. Lado único, `novo`, com os interruptores da config do usuário em
   * 10/10 (leitura guiada e catálogo em níveis ligados); a autonomia é a padrão do
   * plano (sem card = perguntas `nenhuma`, permitir tudo exceto destrutivo).
   */
  a1: {
    reference: '526d549',
    parent: '8c89585',
    titulo: 'escritório 3D: cadeira na altura padrão e uma cadeira por agente na sala de reunião',
    origem: 'handoff real do plano-20261006-1026, sessão 3708b226 (06/10 14:17Z), conversa cmuwrit7ezz9nf',
    plan: { kind: 'copy', from: 'D:/OneDrive/Documentos/agent-code/planning/agent-code/plano-20261006-1026', slug: 'plano-20261006-1026', semEtapas: [] },
    timeoutMs: 60 * 60_000,
    sides: { novo: { leituraGuiada: true, tiered: true } },
    out: 'replay-autonomia-2026-10-10',
    baseSession: '3708b226-14e5-4348-910a-ccd0f8a397e2'
  }
}

/** Teto do trabalho do agente numa rodada da tarefa (a1: 60 min; s1–s3: 10 min). */
export const roundTimeoutOf = (t) => TASKS[t]?.timeoutMs ?? ROUND_TIMEOUT_MS
/** Os lados da tarefa (a1 tem um só, `novo`). */
export const sidesOf = (t) => TASKS[t]?.sides ?? SIDES
/** A referência como o git a entende: um commit, ou a faixa `pai..ponta` quando a entrega foi mais de um. */
export const referenceSpecOf = (t) => (TASKS[t]?.parent ? `${TASKS[t].parent}..${TASKS[t].reference}` : TASKS[t]?.reference)
/** Pasta de resultados da tarefa no repositório. */
export const outOf = (t) => (TASKS[t]?.out ? path.join(REPO, 'docs', 'validation', TASKS[t].out) : OUT)

/**
 * Ordem das tarefas: cada cópia de commit pai POSTERIOR contém a solução das tarefas
 * anteriores (o pai da s1 tem as de s2 e s3; o da s2 tem a da s3). Rodando s1 → s2 → s3
 * e apagando a cópia de cada tarefa ao terminá-la, nenhuma cópia vizinha tem a solução
 * da tarefa em curso.
 */
export const ORDER = ['s1', 's2', 's3']
/** Tarefas da validação da autonomia (relatório próprio: base × novo). */
export const AUTONOMY_TASKS = ['a1']

/** Saídas das rodadas ficam FORA do repositório até as revisões às cegas terminarem (o revisor não vê o lado). */
export const PRIVATE = path.join(ROOT, 'saidas')

/** Pastas de uma tarefa/rodada. A cópia se chama agent-code: o projeto aparece com o mesmo nome do original. */
export const paths = {
  worktree: (t) => path.join(ROOT, t, 'agent-code'),
  frozenPlan: (t) => path.join(ROOT, 'planos', t),
  runData: (t, side, n) => path.join(ROOT, 'runs', `${t}-${side}-r${n}`),
  out: (t, side, n) => path.join(PRIVATE, t, `${side}-r${n}`),
  published: (t, side, n) => path.join(outOf(t), t, `${side}-r${n}`),
  baseline: (t) => path.join(outOf(t), t, 'baseline.json'),
  review: (t, n) => path.join(ROOT, 'revisao', `${t}-par-${n}`),
  reviewResult: (t, n) => path.join(PRIVATE, t, 'revisao', `par-${n}.json`),
  map: (t, n) => path.join(ROOT, 'mapas', `${t}-par-${n}.json`)
}

/** Pastas protegidas: escrita nelas é sempre recusada (checkout e dados reais do usuário). */
export const PROTECTED = [REPO, path.join(process.env.APPDATA ?? 'C:/Users/mathe/AppData/Roaming', 'agent-code-desktop'), 'D:/OneDrive']
