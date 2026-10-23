// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUTO_MODE_MODEL_ENV, autoModeClassifierEnv, configuredAutoModeClassifierModel } from './autoModeClassifier'
import { poAgentOptions } from './po/poAgentQuery'
import { defaultAppConfig, mergeAppConfig } from './persistence/configData'

const req = { prompt: 'p', cwd: 'C:/proj', model: 'claude-sonnet-5-5' }

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : []
  })
}

describe('autoModeClassifierEnv', () => {
  it('define a variável com o modelo escolhido, sem mexer no env de origem', () => {
    const base = { PATH: 'x' }
    expect(autoModeClassifierEnv(base, 'claude-opus-5-5')).toEqual({ PATH: 'x', [AUTO_MODE_MODEL_ENV]: 'claude-opus-5-5' })
    expect(base).toEqual({ PATH: 'x' })
  })

  it('Automático não define a variável (e tira uma herdada)', () => {
    expect(autoModeClassifierEnv({ PATH: 'x', [AUTO_MODE_MODEL_ENV]: 'claude-haiku-5-5' }, 'auto')).toEqual({ PATH: 'x' })
  })

  it('sem a config carregada, vale o padrão Sonnet 5.5', () => {
    expect(configuredAutoModeClassifierModel()).toBe('claude-sonnet-5-5')
  })
})

describe('config autoModeClassifierModel', () => {
  it('padrão Sonnet 5.5; valor fora da lista volta ao padrão', () => {
    expect(defaultAppConfig().autoModeClassifierModel).toBe('claude-sonnet-5-5')
    const haiku = mergeAppConfig(defaultAppConfig(), { autoModeClassifierModel: 'claude-haiku-5-5' })
    expect(haiku.autoModeClassifierModel).toBe('claude-haiku-5-5')
    expect(mergeAppConfig(haiku, { autoModeClassifierModel: 'auto' }).autoModeClassifierModel).toBe('auto')
    expect(mergeAppConfig(haiku, { autoModeClassifierModel: 'gpt-6' }).autoModeClassifierModel).toBe('claude-sonnet-5-5')
    expect(mergeAppConfig(haiku, { memorySelector: 'haiku' }).autoModeClassifierModel).toBe('claude-haiku-5-5')
  })
})

describe('sessões em modo auto (PO com ferramentas)', () => {
  it('passa o modelo escolhido no env, por cima do env da conta', () => {
    const options = poAgentOptions({ ...req, env: { CLAUDE_CONFIG_DIR: 'C:/conta' }, autoModeClassifierModel: 'claude-opus-5-5' }, new AbortController())
    expect(options.permissionMode).toBe('auto')
    expect(options.env).toEqual({ CLAUDE_CONFIG_DIR: 'C:/conta', [AUTO_MODE_MODEL_ENV]: 'claude-opus-5-5' })
  })

  it('Automático não define a variável; sem escolha vale o padrão', () => {
    const auto = poAgentOptions({ ...req, env: { A: '1' }, autoModeClassifierModel: 'auto' }, new AbortController())
    expect(auto.env).toEqual({ A: '1' })
    expect(poAgentOptions({ ...req, env: {} }, new AbortController()).env).toEqual({ [AUTO_MODE_MODEL_ENV]: 'claude-sonnet-5-5' })
  })

  it('todo arquivo com permissionMode auto aplica a variável, e só eles', () => {
    const root = join(__dirname)
    const files = sources(root).map((path) => ({ path: relative(root, path), text: readFileSync(path, 'utf8') }))
    const auto = files.filter((f) => /permissionMode:\s*'auto'/.test(f.text.replace(/^\s*(\*|\/\/).*$/gm, '')))
    expect(auto.map((f) => f.path)).toEqual([join('po', 'poAgentQuery.ts')])
    for (const f of auto) expect(f.text).toMatch(/autoModeClassifierEnv\(/)
    const users = files.filter((f) => /autoModeClassifierEnv\(/.test(f.text) && f.path !== 'autoModeClassifier.ts')
    expect(users.map((f) => f.path)).toEqual(auto.map((f) => f.path))
  })
})
