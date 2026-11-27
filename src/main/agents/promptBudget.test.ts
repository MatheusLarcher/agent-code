// @vitest-environment node
// Tamanho das instruções do time de tarefas e das ferramentas app_* (bytes/4 ≈ tokens).
// ANTES = os mesmos blocos no HEAD 6ed2514, medidos com os escapes resolvidos.
import { describe, expect, it } from 'vitest'
import { TASKS_HINT } from './tasksHint'
import { APP_CALL_HINT, APP_PRINT_HINT, APP_RESTART_HINT, createAppMcpServer } from '../appTools'
import type { GhidraPreparer } from '../ghidra/ghidraEnv'

const BEFORE: Record<string, number> = {
  TASKS_HINT: 4697,
  APP_RESTART_HINT: 405,
  APP_CALL_HINT: 261,
  APP_PRINT_HINT: 397,
  app_anexar_print: 425,
  app_restart: 229,
  app_chamar_usuario: 245,
  app_ativar_android: 353,
  app_ativar_engenharia_reversa: 334,
  app_preparar_ghidra: 438,
  ler_pdf: 203
}

type Registered = Record<string, { description?: string }>
const ghidra = { status: () => ({ state: 'idle' }), detect: async () => null, start: () => {} } as unknown as GhidraPreparer
const tools = (createAppMcpServer({
  cwd: '.', restart: () => ({ ok: true }) as never, attachPrint: async () => ({ ok: true, message: '' }), ghidra,
  enableRea: async () => '', enableAndroid: async () => '', readPdf: true
}) as unknown as { instance: { _registeredTools: Registered } }).instance._registeredTools
const desc = (name: string): string => tools[name].description ?? ''

const AFTER: Record<string, string> = {
  TASKS_HINT,
  APP_RESTART_HINT,
  APP_CALL_HINT,
  APP_PRINT_HINT,
  app_anexar_print: desc('app_anexar_print'),
  app_restart: desc('app_restart'),
  app_chamar_usuario: desc('app_chamar_usuario'),
  app_ativar_android: desc('app_ativar_android'),
  app_ativar_engenharia_reversa: desc('app_ativar_engenharia_reversa'),
  app_preparar_ghidra: desc('app_preparar_ghidra'),
  ler_pdf: desc('ler_pdf')
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')
const row = (name: string, before: number, after: number): string =>
  `${name.padEnd(30)} ${String(before).padStart(7)} B ~${String(Math.round(before / 4)).padStart(5)} tok -> ${String(after).padStart(6)} B ~${String(Math.round(after / 4)).padStart(5)} tok`

describe('orçamento: tarefas e ferramentas app_*', () => {
  it('cada bloco encolheu e o total caiu pelo menos 20%', () => {
    const table: string[] = []
    let totalBefore = 0
    let totalAfter = 0
    for (const [name, text] of Object.entries(AFTER)) {
      const before = BEFORE[name] ?? 0
      const after = bytes(text)
      table.push(row(name, before, after))
      totalBefore += before
      totalAfter += after
    }
    table.push(row('TOTAL', totalBefore, totalAfter))
    console.log(table.join('\n'))
    for (const [name, text] of Object.entries(AFTER)) {
      expect(bytes(text), name).toBeGreaterThan(0)
      expect(bytes(text), name).toBeLessThanOrEqual(BEFORE[name] ?? 0)
    }
    expect(totalAfter).toBeLessThan(totalBefore * 0.8)
  })
})
