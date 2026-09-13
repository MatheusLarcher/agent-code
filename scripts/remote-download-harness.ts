/**
 * Harness manual: sobe a ponte LAN (RemoteServer) sozinha, servindo o cliente
 * do celular em /app, com uma conversa que contém os DOIS caminhos de download
 * (Write entregável + marcador [[download:]]). Serve para exercitar o botão
 * "Baixar" do cliente do celular num navegador real, sem depender do app.
 *
 *   node out/tmp/remote-download-harness.mjs
 *
 * Imprime a URL com token no stdout. Não é usado pelo app.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RemoteServer } from '../src/main/remote/remoteServer'
import type { RemoteConversation } from '../src/shared/ipc'

const dir = mkdtempSync(join(tmpdir(), 'agent-dl-'))
const written = join(dir, 'relatorio.pdf')
writeFileSync(written, 'conteudo-entregavel-pdf')
const marked = join(dir, 'app-debug.apk')
writeFileSync(marked, Buffer.alloc(1024, 7))

const conv: RemoteConversation = {
  id: 'c1',
  title: 'Download',
  cwd: dir,
  busy: false,
  connected: true,
  updatedAt: Date.now(),
  messages: [
    { kind: 'user', id: 'u1', text: 'gera o apk' },
    {
      kind: 'tool-use',
      id: 't1',
      name: 'Write',
      input: { file_path: written, content: 'x' },
      parentToolUseId: null,
      result: { isError: false, text: 'File created successfully.' }
    },
    {
      kind: 'assistant-text',
      id: 'a1',
      text: `Pronto.\n\n[[download:${marked}]]`,
      final: true,
      answer: true
    }
  ]
}

const server = new RemoteServer({
  onInbound: () => {},
  apkPath: () => join(dir, 'nao-existe.apk'),
  wwwDir: () => join(process.cwd(), 'smartfone-remote', 'www')
})

const info = await server.start()
server.setState({ conversations: [conv] })
console.log(JSON.stringify({ url: `http://127.0.0.1:${info.port}/app/?token=${info.token}`, token: info.token, port: info.port, written, marked }))
