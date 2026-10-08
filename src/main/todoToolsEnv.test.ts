import { describe, expect, it } from 'vitest'
import { withTodoTools } from './todoToolsEnv'

describe('withTodoTools — TodoWrite/TaskCreate sempre ligados na sessão', () => {
  it('sem env próprio: parte do ambiente do processo e liga as ferramentas', () => {
    const env = withTodoTools(undefined, { PATH: 'p', CLAUDE_CONFIG_DIR: 'c' })
    expect(env).toEqual({ PATH: 'p', CLAUDE_CONFIG_DIR: 'c', CLAUDE_CODE_ENABLE_TODO_TOOLS: 'true' })
  })

  it('com env da conta/GPT/Ollama: mantém tudo e só acrescenta a chave', () => {
    const own = { ANTHROPIC_BASE_URL: 'http://x', CLAUDE_CONFIG_DIR: 'conta' }
    expect(withTodoTools(own, { PATH: 'ignorado' })).toEqual({ ...own, CLAUDE_CODE_ENABLE_TODO_TOOLS: 'true' })
    expect(own).not.toHaveProperty('CLAUDE_CODE_ENABLE_TODO_TOOLS')
  })
})
