// @vitest-environment node
import { describe, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SqliteRepository } from '../persistence/sqliteRepository'
import { TaskLedger } from './taskLedger'

/**
 * Semeia uma pasta de dados DESCARTÁVEL com tarefas em vários estados, para
 * abrir o app isolado e conferir a aba "Tarefas" com o olho. Não é um teste de
 * regressão — roda só sob demanda (`AGENT_CODE_SEED_BOARD=1`), justamente para
 * nunca escrever numa pasta de dados real durante `npm test`.
 */

const root = process.env.AGENT_CODE_SEED_BOARD_DIR ?? ''
const enabled = process.env.AGENT_CODE_SEED_BOARD === '1' && !!root

describe.runIf(enabled)('seed do painel de tarefas', () => {
  it('cria a pasta de dados e as tarefas de exemplo', async () => {
    const cache = join(root, 'cache', 'agent-code')
    await mkdir(cache, { recursive: true })
    await mkdir(join(root, 'home', '.agent-code'), { recursive: true })
    await writeFile(
      join(root, 'home', '.agent-code', 'location.json'),
      JSON.stringify({ cacheDir: cache }),
      'utf8'
    )

    const repository = new SqliteRepository(cache, join(cache, 'agent-code.db'), 'device-seed')
    await repository.initialize()
    const ledger = new TaskLedger(repository)
    const projectCwd = 'C:\\GitHub\\agent-code'

    // 1) na fila, nunca reivindicada
    await ledger.createTask({
      projectCwd,
      title: 'Cadastro de especialistas (.claude/agents)',
      goal: 'Registrar supervisor, crítico e navegador de código como agentes do SDK.',
      acceptance: ['Options.agents preenchido', 'subagente nasce com o prompt do papel'],
      writeScope: { allow: ['.claude/agents/**'] }
    })

    // 2) em execução, lease vivo
    const running = await ledger.createTask({
      projectCwd,
      title: 'Bash dentro do gate de escopo de escrita',
      goal: 'Fechar a porta que o writeScopeGuard deixa aberta hoje.',
      acceptance: ['comando que grava fora do allow é recusado'],
      writeScope: { allow: ['src/main/tasks/**'], deny: ['src/renderer/**'] }
    })
    const claimA = await ledger.claimTask('session:conv-exec', { taskId: running.id })
    const fenceA = { token: claimA!.token, fencingEpoch: claimA!.fencingEpoch }
    await ledger.transitionTask(running.id, 'pending', 'running', fenceA)
    await ledger.appendStep({ taskId: running.id, kind: 'implement', agent: 'exec', fence: fenceA })

    // 3) em revisão COM evidência
    const review = await ledger.createTask({
      projectCwd,
      title: 'Painel de tarefas lendo o TaskLedger',
      goal: 'Expor a fila do registro numa terceira visão do painel de agentes.',
      acceptance: ['agrupa por estado', 'typecheck e testes passam', 'estado vazio explícito'],
      writeScope: { allow: ['src/renderer/**', 'src/main/tasks/**'] }
    })
    const claimB = await ledger.claimTask('session:conv-painel', { taskId: review.id })
    const fenceB = { token: claimB!.token, fencingEpoch: claimB!.fencingEpoch }
    await ledger.transitionTask(review.id, 'pending', 'running', fenceB)
    const stepB = await ledger.appendStep({ taskId: review.id, kind: 'verify', agent: 'exec', fence: fenceB })
    await ledger.finishStep({ stepId: stepB.id, status: 'done', fence: fenceB })
    await ledger.addDeliverable({ taskId: review.id, kind: 'diff', summary: '6 arquivos', verified: true, fence: fenceB })
    await ledger.addDeliverable({ taskId: review.id, kind: 'test_run', summary: '1043 passaram', fence: fenceB })
    await ledger.transitionTask(review.id, 'running', 'review', fenceB, { reason: 'pronto p/ o crítico' })

    // 4) em revisão SEM evidência — o caso que o painel precisa denunciar
    const bare = await ledger.createTask({
      projectCwd,
      title: 'Mapear project_cwd entre PCs',
      goal: 'Identidade estável de projeto nos registros compartilhados.',
      acceptance: ['dois PCs enxergam a mesma tarefa']
    })
    const claimC = await ledger.claimTask('session:conv-pg', { taskId: bare.id })
    const fenceC = { token: claimC!.token, fencingEpoch: claimC!.fencingEpoch }
    await ledger.transitionTask(bare.id, 'pending', 'running', fenceC)
    await ledger.transitionTask(bare.id, 'running', 'review', fenceC, { reason: 'terminei' })

    // 5) bloqueada
    const blocked = await ledger.createTask({
      projectCwd,
      title: 'Seleção de contexto por especialidade',
      goal: 'Cada especialista recebe só o contexto do seu papel.'
    })
    const claimD = await ledger.claimTask('session:conv-ctx', { taskId: blocked.id })
    const fenceD = { token: claimD!.token, fencingEpoch: claimD!.fencingEpoch }
    await ledger.transitionTask(blocked.id, 'pending', 'running', fenceD)
    await ledger.appendEvent({
      taskId: blocked.id,
      kind: 'blocker',
      data: { reason: 'escopo não cobre src/main/agentSession.ts' }
    })
    await ledger.transitionTask(blocked.id, 'running', 'blocked', fenceD, { reason: 'escopo insuficiente' })

    // 6) concluída, para o chip "Terminadas"
    const done = await ledger.createTask({ projectCwd, title: 'Ponte remota fora da rede', goal: 'já entregue' })
    const claimE = await ledger.claimTask('session:conv-remoto', { taskId: done.id })
    const fenceE = { token: claimE!.token, fencingEpoch: claimE!.fencingEpoch }
    await ledger.transitionTask(done.id, 'pending', 'running', fenceE)
    await ledger.addDeliverable({ taskId: done.id, kind: 'note', summary: 'validado na VPS real', fence: fenceE })
    await ledger.transitionTask(done.id, 'running', 'review', fenceE)
    await ledger.transitionTask(done.id, 'review', 'done', undefined, { agent: 'critico' })
  })
})
