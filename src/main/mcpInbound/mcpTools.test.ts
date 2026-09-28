import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionRequest } from '../../shared/ipc'
import { McpTaskRegistry } from './mcpTasks'
import { commandResolvable, createMcpTools, MCP_TOOL_DEFINITIONS, mcpConversationTitle, type McpDelivery } from './mcpTools'
import { MCP_PLANNING_REFUSED, MCP_TASK_MODEL } from './mcpConstants'

let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-tools-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

function setup(
  over: { exists?: (id: string) => Promise<boolean>; planning?: (id: string) => Promise<boolean>; models?: string[] } = {}
) {
  const registry = new McpTaskRegistry()
  const delivered: McpDelivery[] = []
  const deps = {
    registry,
    conversationExists: vi.fn(over.exists ?? (async () => false)),
    ...(over.planning ? { conversationIsPlanning: over.planning } : {}),
    deliver: (d: McpDelivery) => void delivered.push(d),
    interrupt: vi.fn(),
    dropQueued: vi.fn(),
    answer: vi.fn(),
    newConversationId: () => 'c-novo',
    ...(over.models ? { availableModels: async () => over.models! } : {})
  }
  return { tools: createMcpTools(deps), deps, delivered, registry }
}

const enviar = (tools: ReturnType<typeof setup>['tools'], args: unknown) => tools.call('agent_code_enviar', args)

describe('agent_code_enviar', () => {
  it('cria a pasta do projeto, abre conversa nova "<cliente> — resumo" e responde na hora', async () => {
    const { tools, delivered, registry } = setup()
    const projeto = path.join(tmp, 'Forgia', 'agente')
    const out = await enviar(tools, { prompt: '# Aumente o furo para 8 mm\nuse as forgia_*', cliente: 'Forgia', projeto })
    expect(out?.isError).toBeUndefined()
    expect(out?.value).toEqual({ tarefa_id: expect.any(String), conversa_id: 'c-novo' })
    expect((await fs.stat(projeto)).isDirectory()).toBe(true)
    expect(delivered).toEqual([
      {
        taskId: out!.value.tarefa_id,
        convId: 'c-novo',
        text: '# Aumente o furo para 8 mm\nuse as forgia_*',
        model: MCP_TASK_MODEL,
        create: { cwd: projeto, title: 'Forgia — Aumente o furo para 8 mm' }
      }
    ])
    // Sem `modelo`: a tarefa não guarda modelo e a sessão sobe no padrão de hoje.
    expect(registry.get(String(out!.value.tarefa_id))?.model).toBeUndefined()
    expect(registry.get(String(out!.value.tarefa_id))?.status).toBe('na_fila')
  })

  it('conversa_id existente continua a conversa (sem create); inexistente é erro de validação', async () => {
    const { tools, delivered } = setup({ exists: async (id) => id === 'c-velha' })
    const ok = await enviar(tools, { prompt: 'de novo', cliente: 'Forgia', projeto: tmp, conversa_id: 'c-velha' })
    expect(ok?.value.conversa_id).toBe('c-velha')
    expect(delivered[0].create).toBeUndefined()
    const bad = await enviar(tools, { prompt: 'x', cliente: 'Forgia', projeto: tmp, conversa_id: 'c-sumiu' })
    expect(bad).toMatchObject({ isError: true, value: { erro: 'conversa_id não existe: c-sumiu' } })
    expect(delivered).toHaveLength(1)
  })

  it('conversa do Agent Manager é recusada como destino (com ou sem modelo), sem criar tarefa', async () => {
    const { tools, delivered, registry } = setup({
      exists: async () => true,
      planning: async (id) => id === 'c-plano',
      models: ['claude-opus-5-5', 'gpt-6-sol']
    })
    for (const extra of [{}, { modelo: 'gpt-6-sol' }]) {
      const out = await enviar(tools, { prompt: 'x', cliente: 'Forgia', projeto: tmp, conversa_id: 'c-plano', ...extra })
      expect(out).toMatchObject({ isError: true, value: { erro: MCP_PLANNING_REFUSED } })
    }
    expect(delivered).toEqual([])
    expect(registry.configFor('c-plano')).toBeUndefined()
    const ok = await enviar(tools, { prompt: 'x', cliente: 'Forgia', projeto: tmp, conversa_id: 'c-comum', modelo: 'gpt-6-sol' })
    expect(ok?.isError).toBeUndefined()
  })

  it('conversa aberta agora por outra tarefa vale, mesmo antes de chegar ao banco', async () => {
    const { tools, deps } = setup()
    const first = await enviar(tools, { prompt: 'um', cliente: 'Forgia', projeto: tmp })
    const second = await enviar(tools, { prompt: 'dois', cliente: 'Forgia', projeto: tmp, conversa_id: first!.value.conversa_id })
    expect(second?.isError).toBeUndefined()
    expect(second?.value.conversa_id).toBe('c-novo')
    expect(deps.conversationExists).not.toHaveBeenCalled()
  })

  it('mcp_servers: guarda só para a conversa; nome reservado e command absoluto inexistente são recusados', async () => {
    const { tools, registry } = setup()
    const node = process.execPath
    const ok = await enviar(tools, {
      prompt: 'p',
      cliente: 'Forgia',
      projeto: tmp,
      mcp_servers: { forgia: { command: node, args: ['srv.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } } }
    })
    expect(registry.configFor(String(ok!.value.conversa_id))).toEqual({
      cliente: 'Forgia',
      mcpServers: { forgia: { command: node, args: ['srv.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } } }
    })
    const reserved = await enviar(tools, { prompt: 'p', cliente: 'F', projeto: tmp, mcp_servers: { windows: { command: node } } })
    expect(reserved?.value.erro).toMatch(/"windows" é reservado/)
    const missing = await enviar(tools, {
      prompt: 'p',
      cliente: 'F',
      projeto: tmp,
      mcp_servers: { forgia: { command: path.join(tmp, 'nao-existe.exe') } }
    })
    expect(missing?.value.erro).toMatch(/command não encontrado/)
  })

  it('validação na fronteira: obrigatórios, projeto absoluto, tipos', async () => {
    const { tools, delivered } = setup()
    const bad: unknown[] = [
      {},
      { prompt: '', cliente: 'F', projeto: tmp },
      { prompt: 'p', cliente: '', projeto: tmp },
      { prompt: 'p', cliente: 'F' },
      { prompt: 'p', cliente: 'F', projeto: 'relativo\\pasta' },
      { prompt: 'p', cliente: 'F', projeto: 'C:pasta' },
      { prompt: 'p', cliente: 'F', projeto: '' },
      { prompt: 42, cliente: 'F', projeto: tmp },
      { prompt: 'p', cliente: 'F', projeto: tmp, mcp_servers: { 'nome com espaço': { command: 'node' } } },
      { prompt: 'p', cliente: 'F', projeto: tmp, mcp_servers: { x: { args: [] } } }
    ]
    for (const args of bad) expect((await enviar(tools, args))?.isError).toBe(true)
    expect(delivered).toEqual([])
  })
})

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64')
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]).toString('base64')
const png = (nome: string) => ({ nome, mime: 'image/png', base64: PNG_B64 })

describe('agent_code_enviar: schema dos campos novos', () => {
  it('inputSchema: só os campos do contrato + modelo e imagens, additionalProperties:false', () => {
    const schema = MCP_TOOL_DEFINITIONS[0].inputSchema as { properties: Record<string, unknown>; additionalProperties: boolean }
    expect(Object.keys(schema.properties)).toEqual(['prompt', 'cliente', 'projeto', 'conversa_id', 'mcp_servers', 'modelo', 'imagens'])
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.imagens).toMatchObject({ maxItems: 4, items: { additionalProperties: false } })
    expect(MCP_TOOL_DEFINITIONS[0].description).toMatch(/\[\[imagem:N\]\]/)
    expect(MCP_TOOL_DEFINITIONS[0].description).toMatch(/5 MB/)
  })

  it('campo desconhecido continua recusado (também no zod)', async () => {
    const { tools, delivered } = setup()
    const out = await enviar(tools, { prompt: 'p', cliente: 'F', projeto: tmp, modelos: 'x' })
    expect(out).toMatchObject({ isError: true, value: { erro: 'Parâmetros inválidos: campo desconhecido: modelos' } })
    const inner = await enviar(tools, { prompt: 'p', cliente: 'F', projeto: tmp, imagens: [{ ...png('a.png'), extra: 1 }] })
    expect(inner?.value.erro).toBe('Parâmetros inválidos: imagens.0: campo desconhecido: extra')
    expect(delivered).toEqual([])
  })
})

describe('agent_code_enviar: modelo', () => {
  const modelos = ['claude-opus-5-5', 'claude-sonnet-5', 'gpt-6-sol']

  it('modelo válido: a tarefa roda com ele (registro e entrega)', async () => {
    const { tools, delivered, registry } = setup({ models: modelos })
    const out = await enviar(tools, { prompt: 'p', cliente: 'F', projeto: tmp, modelo: 'gpt-6-sol' })
    expect(out?.isError).toBeUndefined()
    expect(registry.get(String(out!.value.tarefa_id))?.model).toBe('gpt-6-sol')
    expect(delivered[0].model).toBe('gpt-6-sol')
  })

  it('modelo desconhecido ou indisponível: erro com a lista dos válidos, nada é criado', async () => {
    const { tools, delivered } = setup({ models: modelos })
    for (const modelo of ['gpt-9', 'kimi-k3:cloud', 'auto']) {
      const out = await enviar(tools, { prompt: 'p', cliente: 'F', projeto: tmp, modelo })
      expect(out).toEqual({
        isError: true,
        value: { erro: `modelo "${modelo}" não está disponível no Agent Code. Modelos válidos: ${modelos.join(', ')}`, modelos }
      })
    }
    expect((await enviar(tools, { prompt: 'p', cliente: 'F', projeto: tmp, modelo: '' }))?.isError).toBe(true)
    expect(delivered).toEqual([])
  })

  it('com conversa_id: o modelo vale para ESTA tarefa, a seguinte sem modelo volta ao padrão', async () => {
    const { tools, registry } = setup({ models: modelos, exists: async (id) => id === 'c-velha' })
    const a = await enviar(tools, { prompt: 'um', cliente: 'F', projeto: tmp, conversa_id: 'c-velha', modelo: 'claude-sonnet-5' })
    const b = await enviar(tools, { prompt: 'dois', cliente: 'F', projeto: tmp, conversa_id: 'c-velha' })
    expect(registry.get(String(a!.value.tarefa_id))?.model).toBe('claude-sonnet-5')
    expect(registry.get(String(b!.value.tarefa_id))?.model).toBeUndefined()
    // A tarefa é achada pelo id (o que o item da fila leva), com o modelo dela.
    expect(registry.taskFor('c-velha', String(a!.value.tarefa_id))?.model).toBe('claude-sonnet-5')
    expect(registry.taskFor('outra', String(a!.value.tarefa_id))).toBeUndefined()
  })
})

describe('agent_code_enviar: imagens', () => {
  it('aceita de 1 a 4; a 5ª é recusada', async () => {
    const { tools, delivered } = setup()
    for (let n = 1; n <= 4; n++) {
      const imagens = Array.from({ length: n }, (_, i) => png(`i${i + 1}.png`))
      const out = await enviar(tools, { prompt: 'veja', cliente: 'F', projeto: tmp, imagens })
      expect(out?.isError).toBeUndefined()
      expect(delivered.at(-1)?.images).toHaveLength(n)
    }
    const five = Array.from({ length: 5 }, (_, i) => png(`i${i + 1}.png`))
    const out = await enviar(tools, { prompt: 'veja', cliente: 'F', projeto: tmp, imagens: five })
    expect(out).toMatchObject({ isError: true, value: { erro: 'Parâmetros inválidos: imagens: no máximo 4 imagens' } })
    expect((await enviar(tools, { prompt: 'p', cliente: 'F', projeto: tmp, imagens: [] }))?.isError).toBe(true)
  })

  it('recusa mime divergente dos bytes, base64 inválido, mime fora da lista e > 5 MB', async () => {
    const { tools, delivered } = setup()
    const call = (imagens: unknown) => enviar(tools, { prompt: 'p', cliente: 'F', projeto: tmp, imagens })
    expect((await call([{ nome: 'a.png', mime: 'image/png', base64: JPEG_B64 }]))?.value.erro).toBe(
      'imagens[1] (a.png): mime diz image/png, mas os bytes são image/jpeg'
    )
    expect((await call([png('a.png'), { nome: 'b.png', mime: 'image/png', base64: '@@@' }]))?.value.erro).toMatch(
      /^imagens\[2\] \(b\.png\): base64 inválido/
    )
    expect((await call([{ nome: 'a.gif', mime: 'image/gif', base64: PNG_B64 }]))?.value.erro).toMatch(/mime deve ser/)
    const big = Buffer.alloc(5 * 1024 * 1024 + 1)
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect((await call([{ nome: 'g.png', mime: 'image/png', base64: big.toString('base64') }]))?.value.erro).toMatch(/passa de 5 MB/)
    expect(delivered).toEqual([])
  })

  it('[[imagem:N]] vira {{midia:N}} no lugar; sem marcador vai no fim; marcador sem imagem é erro', async () => {
    const { tools, delivered, registry } = setup()
    const out = await enviar(tools, {
      prompt: 'Compare [[imagem:2]] com a peça',
      cliente: 'Forgia',
      projeto: tmp,
      imagens: [png('C:\\tmp\\frente.png'), png('lado.png')]
    })
    expect(delivered[0]).toMatchObject({
      text: 'Compare {{midia:1}} com a peça\n\n{{midia:2}}',
      images: [
        { mediaType: 'image/png', data: PNG_B64, label: 'midia:1 = lado.png' },
        { mediaType: 'image/png', data: PNG_B64, label: 'midia:2 = frente.png' }
      ],
      create: { title: 'Forgia — Compare [mídia 1] com a peça' }
    })
    // O texto da tarefa é o que a tela mostra e manda (o início dela é reconhecido pelo id).
    expect(registry.get(String(out!.value.tarefa_id))?.text).toBe(delivered[0].text)
    const bad = await enviar(tools, { prompt: 'veja [[imagem:2]]', cliente: 'F', projeto: tmp, imagens: [png('a.png')] })
    expect(bad).toMatchObject({ isError: true, value: { erro: expect.stringMatching(/\[\[imagem:2\]\] sem imagem correspondente/) } })
    expect(delivered).toHaveLength(1)
  })
})

describe('agent_code_tarefa / cancelar / responder', () => {
  it('tarefa desconhecida (ex.: depois de reiniciar o app): "Tarefa não encontrada"', async () => {
    const { tools } = setup()
    expect((await tools.call('agent_code_tarefa', { tarefa_id: 't-antiga' }))?.value).toEqual({
      status: 'erro',
      erro: 'Tarefa não encontrada'
    })
    expect((await tools.call('agent_code_cancelar', { tarefa_id: 't-antiga' }))?.value.status).toBe('erro')
    expect((await tools.call('agent_code_tarefa', {}))?.isError).toBe(true)
  })

  it('cancelar na fila tira só o item; rodando faz o Stop da conversa', async () => {
    const { tools, deps, registry } = setup()
    const a = await enviar(tools, { prompt: 'A', cliente: 'F', projeto: tmp })
    const convId = String(a!.value.conversa_id)
    const b = await enviar(tools, { prompt: 'B', cliente: 'F', projeto: tmp, conversa_id: undefined })
    registry.noteSend(convId, String(a!.value.tarefa_id))
    const cq = await tools.call('agent_code_cancelar', { tarefa_id: b!.value.tarefa_id })
    expect(cq?.value).toEqual({ status: 'cancelada' })
    expect(deps.dropQueued).toHaveBeenCalledWith('c-novo', b!.value.tarefa_id)
    const cr = await tools.call('agent_code_cancelar', { tarefa_id: a!.value.tarefa_id })
    expect(cr?.value.status).toBe('cancelada')
    expect(deps.interrupt).toHaveBeenCalledWith(convId)
  })

  it('pergunta aparece no status e agent_code_responder devolve a resposta à sessão', async () => {
    const { tools, deps, registry } = setup()
    const a = await enviar(tools, { prompt: 'faça o chaveiro', cliente: 'Forgia', projeto: tmp })
    const id = String(a!.value.tarefa_id)
    registry.noteSend('c-novo', id)
    const req: PermissionRequest = {
      id: 'perm-1',
      toolName: 'AskUserQuestion',
      input: {},
      deadline: Date.parse('2026-09-26T03:00:00Z'),
      questions: [
        { header: 'Nome', question: 'Qual nome?', multiSelect: false, options: [{ label: 'ANA', description: 'o do pedido' }] },
        { header: 'Furo', question: 'Com furo?', multiSelect: true, options: [{ label: 'Sim', description: '' }] }
      ]
    }
    registry.onQuestion('c-novo', req)
    const st = await tools.call('agent_code_tarefa', { tarefa_id: id })
    expect(st?.value).toEqual({
      status: 'pergunta',
      pergunta: {
        perguntas: [
          { cabecalho: 'Nome', pergunta: 'Qual nome?', multipla: false, opcoes: [{ rotulo: 'ANA', descricao: 'o do pedido' }] },
          { cabecalho: 'Furo', pergunta: 'Com furo?', multipla: true, opcoes: [{ rotulo: 'Sim', descricao: '' }] }
        ],
        prazo: '2026-09-26T03:00:00.000Z'
      }
    })
    expect((await tools.call('agent_code_responder', { tarefa_id: id, respostas: ['ANA'] }))?.value.erro).toMatch(/2 pergunta/)
    const ok = await tools.call('agent_code_responder', { tarefa_id: id, respostas: ['ANA', ['Sim', ' outro ']] })
    expect(ok?.value.status).toBe('rodando')
    expect(deps.answer).toHaveBeenCalledWith('c-novo', {
      id: 'perm-1',
      behavior: 'allow',
      answers: [
        { header: 'Nome', question: 'Qual nome?', selected: ['ANA'] },
        { header: 'Furo', question: 'Com furo?', selected: ['Sim', 'outro'] }
      ]
    })
    // Sem pergunta pendente, responder é erro legível.
    expect((await tools.call('agent_code_responder', { tarefa_id: id, respostas: ['x'] }))?.value.erro).toMatch(/não está esperando/)
  })

  it('ferramenta desconhecida é null (erro de protocolo) e a lista tem as 4', async () => {
    const { tools } = setup()
    expect(await tools.call('outra', {})).toBeNull()
    expect(tools.list().map((t) => t.name)).toEqual([
      'agent_code_enviar',
      'agent_code_tarefa',
      'agent_code_cancelar',
      'agent_code_responder'
    ])
  })
})

describe('commandResolvable', () => {
  const files = new Set(['C:\\bin\\node.exe', 'C:\\tools\\forgia.cmd', 'C:\\abs\\srv.exe'])
  const exists = async (p: string): Promise<boolean> => files.has(p)
  const env = { PATH: 'C:\\bin;C:\\tools', PATHEXT: '.EXE;.CMD' }
  it('absoluto: o arquivo; nome solto: no PATH com PATHEXT; relativo com pasta: não', async () => {
    expect(await commandResolvable('C:\\abs\\srv.exe', exists, env, 'win32')).toBe(true)
    expect(await commandResolvable('C:\\abs\\nada.exe', exists, env, 'win32')).toBe(false)
    expect(await commandResolvable('node', exists, env, 'win32')).toBe(true)
    expect(await commandResolvable('forgia', exists, env, 'win32')).toBe(true)
    expect(await commandResolvable('comando-que-nao-existe', exists, env, 'win32')).toBe(false)
    expect(await commandResolvable('bin\\node.exe', exists, env, 'win32')).toBe(false)
  })
})

describe('mcpConversationTitle', () => {
  it('cliente + 1ª linha do prompt, cortada', () => {
    expect(mcpConversationTitle('Forgia', '\n\n## Faça um chaveiro\nresto')).toBe('Forgia — Faça um chaveiro')
    expect(mcpConversationTitle('Forgia', 'x'.repeat(80))).toBe(`Forgia — ${'x'.repeat(60)}…`)
    expect(mcpConversationTitle('Forgia', '   ')).toBe('Forgia')
  })
})
