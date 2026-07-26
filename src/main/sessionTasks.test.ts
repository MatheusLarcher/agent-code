import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readSessionTasks, sessionTasksDir, watchSessionTasks } from './sessionTasks'
import type { TaskItem } from '../shared/ipc'

let root: string
const SESSION = 'sess-1'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-code-tasks-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeTask(id: string, patch: Record<string, unknown> = {}, session = SESSION): void {
  const dir = sessionTasksDir(session, root)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({
      id,
      subject: `Tarefa ${id}`,
      description: '',
      activeForm: `Fazendo ${id}`,
      status: 'pending',
      ...patch
    })
  )
}

describe('readSessionTasks', () => {
  it('lê o estado real das tarefas da sessão', () => {
    writeTask('1', { status: 'completed' })
    writeTask('2', { status: 'in_progress' })
    const items = readSessionTasks(SESSION, root) as TaskItem[]
    expect(items.map((t) => [t.id, t.status])).toEqual([
      ['1', 'completed'],
      ['2', 'in_progress']
    ])
    expect(items[0].content).toBe('Tarefa 1')
    expect(items[1].activeForm).toBe('Fazendo 2')
  })

  it('ordena por número, não por texto (10 vem depois de 2)', () => {
    writeTask('10')
    writeTask('2')
    writeTask('1')
    expect((readSessionTasks(SESSION, root) as TaskItem[]).map((t) => t.id)).toEqual(['1', '2', '10'])
  })

  it('devolve null quando a sessão nunca usou tarefas (pasta ausente)', () => {
    expect(readSessionTasks('nao-existe', root)).toBeNull()
    expect(readSessionTasks('', root)).toBeNull()
  })

  it('ignora arquivo corrompido/meio escrito em vez de perder a lista toda', () => {
    writeTask('1')
    const dir = sessionTasksDir(SESSION, root)
    writeFileSync(join(dir, '2.json'), '{"id":"2","subject":"corta')
    writeFileSync(join(dir, '.lock'), '')
    const items = readSessionTasks(SESSION, root) as TaskItem[]
    expect(items.map((t) => t.id)).toEqual(['1'])
  })

  it('descarta tarefa sem assunto ou com status desconhecido', () => {
    writeTask('1')
    writeTask('2', { subject: 42 })
    writeTask('3', { status: 'arquivada' })
    expect((readSessionTasks(SESSION, root) as TaskItem[]).map((t) => t.id)).toEqual(['1'])
  })

  it('usa o assunto como activeForm quando ele falta', () => {
    writeTask('1', { activeForm: '' })
    expect((readSessionTasks(SESSION, root) as TaskItem[])[0].activeForm).toBe('Tarefa 1')
  })
})

describe('watchSessionTasks', () => {
  it('avisa quando uma tarefa muda de status', async () => {
    writeTask('1')
    const seen: TaskItem[][] = []
    const stop = watchSessionTasks(SESSION, (items) => seen.push(items), root)
    try {
      writeTask('1', { status: 'in_progress' })
      await new Promise((r) => setTimeout(r, 700))
      expect(seen.length).toBeGreaterThan(0)
      expect(seen[seen.length - 1][0].status).toBe('in_progress')
    } finally {
      stop()
    }
  })

  it('para de avisar depois do dispose', async () => {
    writeTask('1')
    const seen: TaskItem[][] = []
    const stop = watchSessionTasks(SESSION, (items) => seen.push(items), root)
    stop()
    writeTask('1', { status: 'completed' })
    await new Promise((r) => setTimeout(r, 500))
    expect(seen).toEqual([])
  })

  it('não quebra quando a pasta da sessão ainda não existe', async () => {
    const stop = watchSessionTasks('ainda-nao', () => {}, root)
    expect(typeof stop).toBe('function')
    stop()
  })
})
