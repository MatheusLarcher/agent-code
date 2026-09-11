// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '../shared/ipc'
import {
  DownloadAllowlist,
  canonicalPath,
  downloadablesFromEvent,
  downloadablesFromMessages
} from './downloadAllowlist'

const APK = 'C:\\proj\\android\\app-debug.apk'
const SOURCE = 'C:\\proj\\src\\main\\index.ts'
const SECRET = 'C:\\Users\\alguem\\.claude\\.credentials.json'

const write = (file: string): ChatEvent =>
  ({ kind: 'tool-use', id: 't1', name: 'Write', input: { file_path: file }, parentToolUseId: null }) as ChatEvent

const says = (text: string): ChatEvent => ({ kind: 'assistant-text', id: 'a1', text, final: true }) as ChatEvent

/** No persisted conversations — isolates the live set. */
const noHistory = async (): Promise<readonly unknown[][]> => []

describe('regra de download (fonte única da ponte e do desktop)', () => {
  it('libera entregável escrito pelo agente e marcador explícito', () => {
    expect(downloadablesFromEvent(write(APK))).toEqual([APK])
    expect(downloadablesFromEvent(says(`pronto\n[[download:${APK}]]`))).toEqual([APK])
  })

  it('não libera código-fonte só porque foi escrito', () => {
    // O chip existe para entregáveis; um Write de .ts é edição, não entrega.
    expect(downloadablesFromEvent(write(SOURCE))).toEqual([])
  })

  it('ignora o texto parcial do streaming, só olha o final', () => {
    // O streaming emite um `assistant-text` por token com o texto ACUMULADO.
    // Varrer os parciais custaria uma regex sobre a resposta inteira a cada
    // token — quadrático — sem ganho nenhum: o final traz o mesmo marcador.
    const partial = { kind: 'assistant-text', id: 'a1', text: `[[download:${APK}]]`, final: false } as ChatEvent
    expect(downloadablesFromEvent(partial)).toEqual([])
    expect(downloadablesFromEvent(says(`[[download:${APK}]]`))).toEqual([APK])
  })

  it('não libera arquivo apenas citado no texto', () => {
    expect(downloadablesFromEvent(says(`veja ${SECRET} para as credenciais`))).toEqual([])
  })

  it('lê as mesmas duas regras da conversa persistida', () => {
    const messages = [
      null,
      { kind: 'tool-use', name: 'Write', input: { file_path: SOURCE } },
      { kind: 'tool-use', name: 'Write', input: { file_path: APK } },
      { kind: 'assistant-text', text: '[[download:C:\\out\\relatorio.pdf]]' },
      { kind: 'user', text: 'obrigado' }
    ]
    expect(downloadablesFromMessages(messages)).toEqual([APK, 'C:\\out\\relatorio.pdf'])
  })
})

describe('DownloadAllowlist', () => {
  it('autoriza o que o agente entregou nesta sessão', async () => {
    const list = new DownloadAllowlist()
    list.track(write(APK))
    expect(await list.allows(APK, noHistory)).toBe(true)
  })

  it('recusa caminho arbitrário, mesmo existindo em disco', async () => {
    const list = new DownloadAllowlist()
    list.track(write(APK))
    expect(await list.allows(SECRET, noHistory)).toBe(false)
    expect(await list.allows('', noHistory)).toBe(false)
  })

  it('autoriza entregável de conversa restaurada do disco', async () => {
    // O app reiniciou: o set vivo está vazio, mas o chip continua na tela.
    // Recusar aqui quebraria um download legítimo — é o risco desta mudança.
    const list = new DownloadAllowlist()
    const history = async (): Promise<readonly unknown[][]> => [
      [{ kind: 'tool-use', name: 'Write', input: { file_path: APK } }]
    ]
    expect(await list.allows(APK, history)).toBe(true)
  })

  it('só lê o histórico quando o set vivo não sabe, e reusa o resultado', async () => {
    const list = new DownloadAllowlist()
    list.track(write(APK))
    const history = vi.fn(async (): Promise<readonly unknown[][]> => [])

    await list.allows(APK, history)
    expect(history).not.toHaveBeenCalled() // acerto no set vivo: sem ida ao banco

    await list.allows(SECRET, history)
    await list.allows(SECRET, history)
    expect(history).toHaveBeenCalledTimes(1) // varredura cacheada dentro do TTL
  })

  it('falha do armazenamento nega, em vez de liberar tudo', async () => {
    const list = new DownloadAllowlist()
    const broken = async (): Promise<readonly unknown[][]> => {
      throw new Error('banco indisponível')
    }
    // Um download negado o usuário refaz; um allow errado é justamente o que
    // esta classe existe para impedir.
    await expect(list.allows(APK, broken)).resolves.toBe(false)
  })

  it('no Windows, diferença de maiúscula não nega o arquivo certo', async () => {
    const list = new DownloadAllowlist()
    list.track(write(APK))
    const other = APK.toLowerCase()
    const expected = process.platform === 'win32'
    expect(canonicalPath(other) === canonicalPath(APK)).toBe(expected)
    expect(await list.allows(other, noHistory)).toBe(expected)
  })
})
