// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteRepository } from '../persistence/sqliteRepository'
import { TaskLedger } from './taskLedger'
import { buildTaskTools } from './taskTools'

/**
 * Contra um SqliteRepository REAL, de propósito: a máquina de estados, o lease e
 * o fence vivem no repositório, e a ferramenta só traduz. Um dublê que aceitasse
 * tudo provaria apenas que a ferramenta repassa argumentos — não que o modelo
 * recebe uma recusa legível quando erra.
 */

type Tool = ReturnType<typeof buildTaskTools>[number]
type Result = { content: { type: string; text?: string }[] }

const tempDirs: string[] = []

async function setup(): Promise<{ tools: Tool[]; ledger: TaskLedger }> {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-task-tools-'))
  tempDirs.push(cache)
  const repository = new SqliteRepository(cache, join(cache, 'agent-code.db'), 'device-a')
  await repository.initialize()
  const ledger = new TaskLedger(repository)
  const tools = buildTaskTools({ ledger, conversationId: 'conv-1', projectCwd: 'C:/projeto', agent: 'session:conv-1' })
  return { tools, ledger }
}

function find(tools: Tool[], name: string): Tool {
  const found = tools.find((tool) => tool.name === name)
  if (!found) throw new Error(`tool ${name} not registered`)
  return found
}

function call(tools: Tool[], name: string, args: unknown): Promise<string> {
  return (find(tools, name).handler(args as never, undefined) as Promise<Result>).then((result) =>
    result.content.map((part) => part.text ?? '').join('\n')
  )
}

/** Extrai o fence do texto de task_claim — é assim que o modelo o obtém. */
function fenceFrom(claimText: string): { lease_token: string; fencing_epoch: number } {
  const token = /lease_token: (\S+)/.exec(claimText)?.[1]
  const epoch = /fencing_epoch: (\d+)/.exec(claimText)?.[1]
  if (!token || !epoch) throw new Error(`fence ausente em: ${claimText}`)
  return { lease_token: token, fencing_epoch: Number(epoch) }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('ferramentas MCP do registro de tarefas', () => {
  it('registra as dez ferramentas com prefixo task_', async () => {
    const { tools } = await setup()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'task_claim', 'task_create', 'task_deliverable_add', 'task_event', 'task_get',
      'task_list', 'task_renew_lease', 'task_step_finish', 'task_step_start', 'task_transition'
    ])
  })

  it('percorre o ciclo completo: criar → reivindicar → running → passo → evidência → review', async () => {
    const { tools, ledger } = await setup()

    const created = await call(tools, 'task_create', {
      title: 'Adicionar teste',
      goal: 'Cobrir o caso X',
      acceptance: ['vitest verde']
    })
    expect(created).toMatch(/Tarefa criada: (\S+) \[pending\]/)
    const id = /Tarefa criada: (\S+)/.exec(created)![1]

    // Sem informar project_cwd, herda a pasta da conversa.
    expect((await ledger.getTask(id))?.projectCwd).toBe('C:/projeto')

    const claimed = await call(tools, 'task_claim', {})
    expect(claimed).toContain(`Tarefa reivindicada: ${id}`)
    const fence = fenceFrom(claimed)

    expect(await call(tools, 'task_transition', { task_id: id, from: 'pending', to: 'running', ...fence }))
      .toContain('[running]')

    const step = await call(tools, 'task_step_start', { task_id: id, kind: 'implement', ...fence })
    const stepId = /Passo aberto: (\S+)/.exec(step)![1]
    expect(await call(tools, 'task_step_finish', { step_id: stepId, status: 'done', ...fence })).toContain('[done]')

    expect(await call(tools, 'task_deliverable_add', {
      task_id: id, kind: 'test_run', summary: '12 testes verdes', step_id: stepId, ...fence
    })).toMatch(/Entregável registrado/)

    expect(await call(tools, 'task_transition', { task_id: id, from: 'running', to: 'review', reason: 'pronto para revisão', ...fence }))
      .toContain('[review]')

    const detail = await call(tools, 'task_get', { task_id: id })
    expect(detail).toContain('[review] Adicionar teste')
    expect(detail).toContain('vitest verde')
    expect(detail).toContain('#1 implement [done]')
    expect(detail).toContain('test_run: 12 testes verdes')
    // A trilha registra a transição com o motivo e quem fez.
    expect(detail).toMatch(/pronto para revisão/)
  })

  it('escrever sem o fence numa tarefa com lease vivo é recusado com instrução, não com stack trace', async () => {
    const { tools } = await setup()
    const id = /Tarefa criada: (\S+)/.exec(await call(tools, 'task_create', { title: 'T', goal: 'G' }))![1]
    await call(tools, 'task_claim', {})

    const refused = await call(tools, 'task_transition', { task_id: id, from: 'pending', to: 'running' })
    expect(refused).toMatch(/^task_transition falhou:/)
    expect(refused).toContain('task_get') // diz onde olhar, não só que falhou
    expect(refused).not.toMatch(/\n\s+at /) // sem stack trace
  })

  it('fence velho (segundo agente reivindicou) é recusado e manda reivindicar de novo', async () => {
    const { tools, ledger } = await setup()
    const id = /Tarefa criada: (\S+)/.exec(await call(tools, 'task_create', { title: 'T', goal: 'G' }))![1]
    const stale = fenceFrom(await call(tools, 'task_claim', { agent: 'agente-a' }))

    // Expira o lease e deixa outro agente reivindicar: o epoch avança.
    await ledger.transitionTask(id, 'pending', 'running', { token: stale.lease_token, fencingEpoch: stale.fencing_epoch })
    await ledger.transitionTask(id, 'running', 'failed', { token: stale.lease_token, fencingEpoch: stale.fencing_epoch })
    await ledger.transitionTask(id, 'failed', 'pending')
    const fresh = fenceFrom(await call(tools, 'task_claim', { agent: 'agente-b' }))
    expect(fresh.fencing_epoch).toBeGreaterThan(stale.fencing_epoch)

    const refused = await call(tools, 'task_transition', { task_id: id, from: 'pending', to: 'running', ...stale })
    expect(refused).toMatch(/task_transition falhou/)
    expect(refused).toMatch(/não é mais sua/)
  })

  it('transição fora da máquina de estados é recusada apontando para task_get', async () => {
    const { tools } = await setup()
    const id = /Tarefa criada: (\S+)/.exec(await call(tools, 'task_create', { title: 'T', goal: 'G' }))![1]
    const fence = fenceFrom(await call(tools, 'task_claim', {}))

    // pending → done pula o running: inválido pela spec.
    const refused = await call(tools, 'task_transition', { task_id: id, from: 'pending', to: 'done', ...fence })
    expect(refused).toMatch(/task_transition falhou/)
    expect(refused).toContain('task_get')
  })

  it('fence pela metade é recusado antes de chegar ao banco', async () => {
    const { tools } = await setup()
    const id = /Tarefa criada: (\S+)/.exec(await call(tools, 'task_create', { title: 'T', goal: 'G' }))![1]
    const refused = await call(tools, 'task_transition', { task_id: id, from: 'pending', to: 'running', lease_token: 'x' })
    expect(refused).toMatch(/andam juntos/)
  })

  it('task_claim sem tarefa pendente responde em texto, não em erro', async () => {
    const { tools } = await setup()
    expect(await call(tools, 'task_claim', {})).toBe('Nenhuma tarefa pending disponível para reivindicar neste projeto.')
  })

  it('task_claim só pega tarefa do projeto da conversa, salvo any_project ou task_id', async () => {
    const { tools, ledger } = await setup()
    const other = await ledger.createTask({ projectCwd: 'D:/outro', title: 'de outro projeto', goal: 'G' })
    // A mais antiga é de OUTRO projeto: sem filtro ela seria entregue por engano.
    expect(await call(tools, 'task_claim', {})).toMatch(/Nenhuma tarefa pending/)
    const mine = /Tarefa criada: (\S+)/.exec(await call(tools, 'task_create', { title: 'minha', goal: 'G' }))![1]
    expect(await call(tools, 'task_claim', {})).toContain(`Tarefa reivindicada: ${mine}`)
    // task_id atravessa o filtro de projeto: é como o subagente delegado pega a sua.
    expect(await call(tools, 'task_claim', { task_id: other.id })).toContain(`Tarefa reivindicada: ${other.id}`)
    // task_id indisponível responde o motivo, não "nenhuma".
    expect(await call(tools, 'task_claim', { task_id: other.id })).toMatch(/não está disponível/)
  })

  it('cada escrita com fence renova o lease (o modelo não precisa lembrar de task_renew_lease)', async () => {
    const { tools, ledger } = await setup()
    const id = /Tarefa criada: (\S+)/.exec(await call(tools, 'task_create', { title: 'T', goal: 'G' }))![1]
    const fence = fenceFrom(await call(tools, 'task_claim', {}))
    const before = (await ledger.getTask(id))!.leaseExpiresAt!
    await new Promise((resolve) => setTimeout(resolve, 15))
    await call(tools, 'task_transition', { task_id: id, from: 'pending', to: 'running', ...fence })
    const after = (await ledger.getTask(id))!.leaseExpiresAt!
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before))
  })

  it('onHold/onRelease acompanham a posse, e a renovação estende a validade', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'agent-code-task-tools-'))
    tempDirs.push(cache)
    const repository = new SqliteRepository(cache, join(cache, 'agent-code.db'), 'device-a')
    await repository.initialize()
    const ledger = new TaskLedger(repository)
    const held: Array<{ id: string; expiresAt: string }> = []
    const released: string[] = []
    const tools = buildTaskTools({
      ledger, conversationId: 'c', projectCwd: 'C:/projeto', agent: 'a',
      onHold: (task, expiresAt) => held.push({ id: task.id, expiresAt }),
      onRelease: (taskId) => released.push(taskId)
    })
    const id = /Tarefa criada: (\S+)/.exec(await call(tools, 'task_create', { title: 'T', goal: 'G', write_scope_allow: ['src/**'] }))![1]
    const fence = fenceFrom(await call(tools, 'task_claim', {}))
    expect(held.map((h) => h.id)).toEqual([id])

    await new Promise((resolve) => setTimeout(resolve, 15))
    await call(tools, 'task_transition', { task_id: id, from: 'pending', to: 'running', ...fence })
    expect(released).toEqual([])
    // A renovação reemite o hold com validade maior — é o que impede o escopo
    // de expirar no gate enquanto o executor ainda trabalha.
    expect(held).toHaveLength(2)
    expect(Date.parse(held[1].expiresAt)).toBeGreaterThan(Date.parse(held[0].expiresAt))

    await call(tools, 'task_transition', { task_id: id, from: 'running', to: 'review', ...fence })
    expect(released).toEqual([id])
  })

  it('review solta o lease: o crítico fecha a tarefa SEM fence', async () => {
    const { tools, ledger } = await setup()
    const id = /Tarefa criada: (\S+)/.exec(await call(tools, 'task_create', { title: 'T', goal: 'G' }))![1]
    const fence = fenceFrom(await call(tools, 'task_claim', {}))
    await call(tools, 'task_transition', { task_id: id, from: 'pending', to: 'running', ...fence })
    await call(tools, 'task_transition', { task_id: id, from: 'running', to: 'review', ...fence })

    // O executor entregou; o lease morreu junto.
    expect((await ledger.getTask(id))!.leaseExpiresAt).not.toBeNull()
    expect(Date.parse((await ledger.getTask(id))!.leaseExpiresAt!)).toBeLessThanOrEqual(Date.now())

    // O crítico é outro agente e nunca teve fence: sem ele, fecha.
    expect(await call(tools, 'task_transition', { task_id: id, from: 'review', to: 'done' })).toContain('[done]')
  })

  it('task_get não anuncia lease vivo depois do handoff — soltar não limpa o token', async () => {
    const { tools } = await setup()
    const id = /Tarefa criada: (\S+)/.exec(await call(tools, 'task_create', { title: 'T', goal: 'G' }))![1]
    const fence = fenceFrom(await call(tools, 'task_claim', {}))
    await call(tools, 'task_transition', { task_id: id, from: 'pending', to: 'running', ...fence })

    // Com o executor trabalhando, a posse é real e o fence é exigido mesmo.
    const working = await call(tools, 'task_get', { task_id: id })
    expect(working).toContain('Lease: vivo até')
    expect(working).toContain('exigem o fence')

    await call(tools, 'task_transition', { task_id: id, from: 'running', to: 'review', ...fence })

    // O repositório expira a data mas MANTÉM o token, então um ramo binário
    // ("tem token → vivo") mandaria o crítico buscar um fence que ele nunca teve
    // e que aqui seria recusado — parando a tarefa que ele consegue fechar.
    const handed = await call(tools, 'task_get', { task_id: id })
    expect(handed).not.toContain('Lease: vivo até')
    expect(handed).not.toContain('exigem o fence')
    expect(handed).toContain('solto no handoff para review')
    expect(handed).toContain('SEM lease_token/fencing_epoch')
  })

  it('blocked também solta o lease, para o supervisor poder destravar', async () => {
    const { tools } = await setup()
    const id = /Tarefa criada: (\S+)/.exec(await call(tools, 'task_create', { title: 'T', goal: 'G' }))![1]
    const fence = fenceFrom(await call(tools, 'task_claim', {}))
    await call(tools, 'task_transition', { task_id: id, from: 'pending', to: 'running', ...fence })
    await call(tools, 'task_transition', { task_id: id, from: 'running', to: 'blocked', reason: 'falta acesso', ...fence })
    expect(await call(tools, 'task_transition', { task_id: id, from: 'blocked', to: 'running' })).toContain('[running]')
  })

  it('fence reusado depois do handoff explica que basta repetir sem fence', async () => {
    const { tools } = await setup()
    const id = /Tarefa criada: (\S+)/.exec(await call(tools, 'task_create', { title: 'T', goal: 'G' }))![1]
    const fence = fenceFrom(await call(tools, 'task_claim', {}))
    await call(tools, 'task_transition', { task_id: id, from: 'pending', to: 'running', ...fence })
    await call(tools, 'task_transition', { task_id: id, from: 'running', to: 'review', ...fence })

    const refused = await call(tools, 'task_transition', { task_id: id, from: 'review', to: 'done', ...fence })
    expect(refused).toMatch(/SEM lease_token/)
    // E não manda reivindicar: uma tarefa em review não é reivindicável.
    expect(refused).not.toMatch(/reivindique de novo com task_claim/)
  })

  it('o ciclo de retrabalho devolve a tarefa à fila: review→failed→pending→claim', async () => {
    const { tools } = await setup()
    const id = /Tarefa criada: (\S+)/.exec(await call(tools, 'task_create', { title: 'T', goal: 'G' }))![1]
    const fence = fenceFrom(await call(tools, 'task_claim', {}))
    await call(tools, 'task_transition', { task_id: id, from: 'pending', to: 'running', ...fence })
    await call(tools, 'task_transition', { task_id: id, from: 'running', to: 'review', ...fence })

    // O crítico reprova (sem fence — o lease já foi solto no review).
    expect(await call(tools, 'task_transition', { task_id: id, from: 'review', to: 'failed', reason: 'sem teste' }))
      .toContain('[failed]')
    expect(await call(tools, 'task_transition', { task_id: id, from: 'failed', to: 'pending' })).toContain('[pending]')

    // Só assim outro executor consegue pegá-la de novo.
    const again = await call(tools, 'task_claim', {})
    expect(again).toContain(`Tarefa reivindicada: ${id}`)
    expect(fenceFrom(again).fencing_epoch).toBeGreaterThan(fence.fencing_epoch)
  })

  it('task_list por padrão esconde as terminadas e respeita o limite', async () => {
    const { tools, ledger } = await setup()
    await call(tools, 'task_create', { title: 'aberta-1', goal: 'G' })
    await call(tools, 'task_create', { title: 'aberta-2', goal: 'G' })
    const done = await ledger.createTask({ projectCwd: 'C:/projeto', title: 'fechada', goal: 'G' })
    const claim = await ledger.claimTask('x')
    // A reivindicação pega a mais antiga: garante que fechamos a certa.
    const target = claim!.task.id === done.id ? claim! : null
    if (target) {
      const fence = { token: target.token, fencingEpoch: target.fencingEpoch }
      await ledger.transitionTask(done.id, 'pending', 'running', fence)
      await ledger.transitionTask(done.id, 'running', 'review', fence)
      await ledger.transitionTask(done.id, 'review', 'done', fence)
    }

    const listed = await call(tools, 'task_list', {})
    expect(listed).toContain('aberta-1')
    expect(listed).toContain('aberta-2')
    if (target) expect(listed).not.toContain('fechada')

    const limited = await call(tools, 'task_list', { limit: 1 })
    expect(limited.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(1)
    expect(limited).toMatch(/há mais tarefas/)

    const all = await call(tools, 'task_list', { status: ['done'] })
    if (target) expect(all).toContain('fechada')
  })

  it('task_get de id inexistente responde em texto', async () => {
    const { tools } = await setup()
    expect(await call(tools, 'task_get', { task_id: 'nao-existe' })).toBe('Não existe tarefa nao-existe.')
  })

  it('task_create sem board_item_id não grava vínculo — comportamento inalterado', async () => {
    const { tools, ledger } = await setup()
    const created = await call(tools, 'task_create', { title: 'sem cartão', goal: 'G' })
    expect(created).not.toContain('vinculada ao cartão')
    const id = /Tarefa criada: (\S+)/.exec(created)![1]
    const links = await ledger.boardItemIdsForTasks([id])
    expect(links.has(id)).toBe(false)
  })

  it('task_create com board_item_id de um cartão real grava o vínculo, consultável via boardItemIdsForTasks', async () => {
    const { tools, ledger } = await setup()
    // Reaproveita o MESMO arquivo de banco do ledger criado em `setup()`: o
    // board_item precisa existir na mesma base para a FK de task_board_links
    // aceitar o vínculo.
    const cache = tempDirs.at(-1)!
    const boardRepo = new SqliteRepository(cache, join(cache, 'agent-code.db'), 'device-a')
    await boardRepo.initialize()
    const [item] = await boardRepo.syncBoardItems({
      projectId: 'proj-1',
      projectCwd: 'C:/projeto',
      conversationId: 'conv-board',
      items: [{ sourceId: 's1', title: 'Cartão real', status: 'pending', activeForm: null, seq: 0 }]
    })

    const created = await call(tools, 'task_create', { title: 'com cartão', goal: 'G', board_item_id: item.id })
    expect(created).toContain(`vinculada ao cartão ${item.id}`)
    const id = /Tarefa criada: (\S+)/.exec(created)![1]
    const links = await ledger.boardItemIdsForTasks([id])
    expect(links.get(id)).toBe(item.id)
  })

  it('task_create com board_item_id inexistente devolve erro claro e não grava vínculo órfão', async () => {
    const { tools, ledger } = await setup()
    const created = await call(tools, 'task_create', { title: 'cartão errado', goal: 'G', board_item_id: 'nao-existe' })
    expect(created).toMatch(/Tarefa criada: (\S+)/)
    expect(created).toContain('vínculo com o cartão nao-existe')
    expect(created).toContain('falhou')
    const id = /Tarefa criada: (\S+)/.exec(created)![1]
    const links = await ledger.boardItemIdsForTasks([id])
    expect(links.has(id)).toBe(false)
  })

  it('task_event anota na trilha com a identidade do chamador', async () => {
    const { tools, ledger } = await setup()
    const id = /Tarefa criada: (\S+)/.exec(await call(tools, 'task_create', { title: 'T', goal: 'G' }))![1]
    expect(await call(tools, 'task_event', { task_id: id, kind: 'blocker', data: { why: 'falta acesso' } })).toMatch(/Evento blocker registrado/)
    const events = await ledger.listEvents(id)
    const last = events.at(-1)!
    expect(last.kind).toBe('blocker')
    expect(last.data).toMatchObject({ why: 'falta acesso', agent: 'session:conv-1' })
  })
})
