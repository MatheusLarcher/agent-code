import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface, type Interface as ReadLineInterface } from 'node:readline'

interface NativeResponse<T> {
  id: string
  result?: T
  error?: { message?: string }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
  removeAbort?: () => void
}

export class WindowsControlClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private lines: ReadLineInterface | null = null
  private pending = new Map<string, PendingRequest>()
  private stderrTail = ''

  constructor(private readonly executablePath: () => string) {}

  async request<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw abortError()
    const child = this.ensureStarted()
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Controle do Windows excedeu o tempo limite em ${method}.`))
        this.stop('O helper parou após exceder o tempo limite.')
      }, 45_000)
      timer.unref?.()

      const request: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      }
      if (signal) {
        const onAbort = (): void => {
          this.pending.delete(id)
          clearTimeout(timer)
          reject(abortError())
          this.stop('A ação do Windows foi interrompida.')
        }
        signal.addEventListener('abort', onAbort, { once: true })
        request.removeAbort = () => signal.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, request)
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return
        this.finish(id, error)
      })
    })
  }

  stop(reason = 'Controle do Windows desativado.'): void {
    const child = this.child
    this.child = null
    this.lines?.close()
    this.lines = null
    if (child && !child.killed) child.kill()
    const error = new Error(reason)
    for (const id of [...this.pending.keys()]) this.finish(id, error)
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child
    const executable = this.executablePath()
    this.stderrTail = ''
    const child = spawn(executable, [], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    this.lines = createInterface({ input: child.stdout })
    this.lines.on('line', (line) => this.handleLine(line))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2_000)
    })
    child.once('error', (error) => {
      if (this.child !== child) return
      this.child = null
      this.rejectAll(error)
    })
    child.once('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      if (this.pending.size === 0) return
      const detail = this.stderrTail.trim()
      this.rejectAll(new Error(`Helper do Windows encerrou (código ${code ?? 'desconhecido'})${detail ? `: ${detail}` : '.'}`))
    })
    return child
  }

  private handleLine(line: string): void {
    let response: NativeResponse<unknown>
    try {
      response = JSON.parse(line) as NativeResponse<unknown>
    } catch {
      return
    }
    if (!response.id || !this.pending.has(response.id)) return
    if (response.error) {
      this.finish(response.id, new Error(response.error.message || 'Falha no controle do Windows.'))
      return
    }
    this.finish(response.id, undefined, response.result)
  }

  private finish(id: string, error?: Error, result?: unknown): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.removeAbort?.()
    if (error) pending.reject(error)
    else pending.resolve(result)
  }

  private rejectAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.finish(id, error)
  }
}

function abortError(): Error {
  const error = new Error('A ação do Windows foi interrompida.')
  error.name = 'AbortError'
  return error
}
