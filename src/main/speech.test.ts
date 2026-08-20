// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { localSpeechSizeMb, parseWorkerChunk } from './speech'
import { DEFAULT_LOCAL_SPEECH_MODEL, LOCAL_SPEECH_MODELS, localSpeechRuntime } from '../shared/ipc'

describe('catálogo de modelos locais', () => {
  it('oferece os dois da NVIDIA (rápido e preciso), nenhum Whisper', () => {
    expect(LOCAL_SPEECH_MODELS.map((m) => m.id)).toEqual([
      'nvidia/parakeet-tdt-0.6b-v3',
      'nvidia/canary-1b-v2'
    ])
    expect(LOCAL_SPEECH_MODELS.every((m) => !m.id.includes('whisper'))).toBe(true)
    expect(DEFAULT_LOCAL_SPEECH_MODEL).toBe('nvidia/parakeet-tdt-0.6b-v3') // o rápido é o padrão
  })

  it('cada modelo declara em qual stack roda (não podem dividir ambiente)', () => {
    expect(localSpeechRuntime('nvidia/parakeet-tdt-0.6b-v3')).toBe('transformers')
    expect(localSpeechRuntime('nvidia/canary-1b-v2')).toBe('nemo')
    expect(localSpeechRuntime('modelo-desconhecido')).toBe('transformers') // fallback no leve
  })

  it('sabe o tamanho anunciado de cada modelo', () => {
    expect(localSpeechSizeMb('nvidia/parakeet-tdt-0.6b-v3')).toBe(2400)
    expect(localSpeechSizeMb('nvidia/canary-1b-v2')).toBe(6400)
    expect(localSpeechSizeMb('modelo-que-nao-existe')).toBeUndefined()
  })
})

describe('protocolo do transcritor', () => {
  it('lê uma resposta completa', () => {
    const { messages, rest } = parseWorkerChunk('', '{"id":"a1","text":"olá mundo"}\n')
    expect(messages).toEqual([{ id: 'a1', text: 'olá mundo' }])
    expect(rest).toBe('')
  })

  it('junta mensagem partida em dois pedaços da stream', () => {
    const first = parseWorkerChunk('', '{"id":"a1","te')
    expect(first.messages).toEqual([])
    const second = parseWorkerChunk(first.rest, 'xt":"parcial"}\n')
    expect(second.messages).toEqual([{ id: 'a1', text: 'parcial' }])
  })

  it('lê várias mensagens de uma vez', () => {
    const { messages } = parseWorkerChunk(
      '',
      '{"event":"downloading","message":"baixando"}\n{"event":"ready","message":"pronto"}\n'
    )
    expect(messages.map((m) => m.event)).toEqual(['downloading', 'ready'])
  })

  it('ignora aviso de biblioteca no meio da saída (não quebra o ditado)', () => {
    const { messages } = parseWorkerChunk(
      '',
      'FutureWarning: torch blá blá\n{"id":"a1","text":"funcionou"}\nUserWarning: outro aviso\n'
    )
    expect(messages).toEqual([{ id: 'a1', text: 'funcionou' }])
  })

  it('linha JSON inválida não derruba nem some com as válidas', () => {
    const { messages } = parseWorkerChunk('', '{quebrado\n{"id":"a2","error":"faltou áudio"}\n')
    expect(messages).toEqual([{ id: 'a2', error: 'faltou áudio' }])
  })

  it('guarda o resto incompleto para o próximo pedaço', () => {
    const { messages, rest } = parseWorkerChunk('', '{"id":"a1","text":"ok"}\n{"id":"a2"')
    expect(messages).toHaveLength(1)
    expect(rest).toBe('{"id":"a2"')
  })
})
