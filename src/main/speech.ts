import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SpeechSetupProgress } from '../shared/ipc'
import { LOCAL_SPEECH_MODELS, localSpeechRuntime } from '../shared/ipc'
import { getCacheInfo } from './store'

/**
 * On-device dictation with NVIDIA's Parakeet TDT — the same model used in the
 * user's other projects, chosen over Whisper after measuring both.
 *
 * Nothing here runs when the app starts. The environment is only built the first
 * time someone actually dictates with the local engine, and it's built as cheap
 * as possible: instead of installing a second CUDA stack (~4 GB), we find the
 * Python that ALREADY has torch+CUDA on this machine and layer a small venv on
 * top of it (`--system-site-packages`) carrying just the newer `transformers`.
 * The model weights come from the shared Hugging Face cache, so a machine that
 * already pulled Parakeet for another project downloads nothing at all.
 */

type ProgressFn = (p: SpeechSetupProgress) => void

/**
 * What each runtime needs on top of the inherited torch/CUDA. They get SEPARATE
 * environments on purpose: Parakeet wants `transformers >= 5.10` while NeMo pins
 * an older one, so sharing a venv would break whichever was installed second.
 */
const REQUIREMENTS: Record<'transformers' | 'nemo', string[]> = {
  transformers: ['transformers>=5.10'],
  nemo: ['nemo_toolkit[asr]']
}

/** One folder per runtime — see REQUIREMENTS. */
function envDir(runtime: 'transformers' | 'nemo'): string {
  return join(getCacheInfo().dir, 'speech-env', runtime)
}

/** python.exe of our layered venv (Windows layout; POSIX kept for tests/CI). */
function venvPython(dir: string): string {
  return process.platform === 'win32' ? join(dir, 'Scripts', 'python.exe') : join(dir, 'bin', 'python')
}

/** Written only after the install finishes. Its content is the requirement it
 *  was built for, so bumping the requirement rebuilds the environment. */
function readyMark(dir: string): string {
  return join(dir, '.ready')
}

/**
 * An environment counts as ready only when the install COMPLETED. Checking for
 * `python.exe` alone was wrong: closing the app mid-install leaves the venv on
 * disk but half-built, and the next run happily used it and failed at import.
 */
export function isLocalSpeechReady(runtime: 'transformers' | 'nemo' = 'transformers'): boolean {
  const dir = envDir(runtime)
  try {
    return (
      existsSync(venvPython(dir)) &&
      readFileSync(readyMark(dir), 'utf8').trim() === REQUIREMENTS[runtime].join(' ')
    )
  } catch {
    return false
  }
}

/**
 * True when this machine already downloaded the model — the Hugging Face cache
 * is SHARED with every other project here, so someone who used Parakeet
 * elsewhere pays nothing. Drives the wording ("baixando" vs "carregando"): the
 * download is gigabytes, the load is seconds, and promising the wrong one is
 * what makes a progress notice feel like a lie.
 */
export function isModelCached(model: string): boolean {
  const home =
    process.env.HF_HOME ??
    (process.env.HF_HUB_CACHE ? join(process.env.HF_HUB_CACHE, '..') : join(homedir(), '.cache', 'huggingface'))
  return existsSync(join(home, 'hub', `models--${model.replace(/\//g, '--')}`))
}

export function localSpeechSizeMb(model: string): number | undefined {
  return LOCAL_SPEECH_MODELS.find((m) => m.id === model)?.sizeMb
}

/** Ask a Python whether it has torch with a working CUDA device. */
function probePython(exe: string): { ok: boolean; torch?: string; cuda?: boolean } {
  try {
    const r = spawnSync(
      exe,
      ['-c', 'import torch,json;print(json.dumps({"t":torch.__version__,"c":torch.cuda.is_available()}))'],
      { encoding: 'utf8', timeout: 90_000 }
    )
    if (r.status !== 0 || !r.stdout) return { ok: false }
    const out = JSON.parse(r.stdout.trim().split('\n').pop() as string) as { t: string; c: boolean }
    return { ok: true, torch: out.t, cuda: out.c }
  } catch {
    return { ok: false }
  }
}

/** Every home directory worth searching. `homedir()` follows HOME/USERPROFILE,
 *  which a launcher (or a test harness) can point elsewhere — `userInfo()` gives
 *  the account's real home, so a conda install is still found either way. */
function homeCandidates(): string[] {
  const homes = new Set<string>([homedir()])
  if (process.env.USERPROFILE) homes.add(process.env.USERPROFILE)
  try {
    const real = userInfo().homedir
    if (real) homes.add(real)
  } catch {
    /* userInfo can fail on odd setups — the others still apply */
  }
  return [...homes]
}

/** Pythons worth probing, best candidates first: conda envs (where a GPU stack
 *  usually lives on this kind of setup), then whatever is on PATH. */
function pythonCandidates(): string[] {
  const list: string[] = []
  const conda = process.env.CONDA_PREFIX
  if (conda) list.push(join(conda, 'python.exe'), join(conda, 'bin', 'python'))

  const roots: string[] = []
  for (const home of homeCandidates()) {
    roots.push(join(home, 'miniconda3'), join(home, 'anaconda3'), join(home, 'miniforge3'))
  }
  // Conda instalado para todos os usuários.
  if (process.env.ProgramData) {
    roots.push(join(process.env.ProgramData, 'miniconda3'), join(process.env.ProgramData, 'anaconda3'))
  }
  // A raiz do conda também é dedutível do executável, quando ele está no PATH.
  if (process.env.CONDA_EXE) roots.push(join(process.env.CONDA_EXE, '..', '..'))

  for (const root of roots) {
    const envs = join(root, 'envs')
    try {
      for (const name of readdirSync(envs)) list.push(join(envs, name, 'python.exe'), join(envs, name, 'bin', 'python'))
    } catch {
      /* no conda here */
    }
    list.push(join(root, 'python.exe'), join(root, 'bin', 'python'))
  }
  list.push('python', 'python3')
  return list
}

/** The Python we layer our venv on: the first one that has torch + CUDA. */
export function findCudaPython(): { exe: string; torch: string } | null {
  for (const exe of pythonCandidates()) {
    if (exe.includes('\\') || exe.includes('/')) {
      if (!existsSync(exe)) continue
    }
    const p = probePython(exe)
    if (p.ok && p.cuda) return { exe, torch: p.torch ?? '?' }
  }
  return null
}

function run(exe: string, args: string[], cwd: string, onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    // `cwd` sempre na pasta do ambiente: rodando na pasta do app, o pip chegou a
    // despejar o cache dele dentro do projeto (uma pasta `pip/` de 17 MB).
    const child = spawn(exe, args, { windowsHide: true, cwd })
    let err = ''
    const feed = (buf: Buffer): void => {
      for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) onLine?.(line.trim())
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', (b: Buffer) => {
      err += b.toString()
      feed(b)
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `saiu com ${code}`))
    )
  })
}

/**
 * Build (once) the small venv that runs the transcriber. Returns the path of its
 * python. Throws with a user-facing message when the machine has no CUDA Python.
 */
/** Preparação em andamento, por runtime. Sem isso, dois ditados seguidos
 *  disparam duas instalações ao mesmo tempo e uma apaga a pasta que a outra está
 *  criando (deu EPERM em teste real) — a segunda espera a primeira. */
const envPromises = new Map<string, Promise<string>>()

async function ensureEnv(runtime: 'transformers' | 'nemo', onProgress: ProgressFn): Promise<string> {
  const dir = envDir(runtime)
  const py = venvPython(dir)
  if (isLocalSpeechReady(runtime)) return py
  const running = envPromises.get(runtime)
  if (running) return running

  const build = async (): Promise<string> => {
    onProgress({ stage: 'preparing', message: 'Preparando o reconhecimento de voz neste computador…' })
    const base = findCudaPython()
    if (!base) {
      throw new Error(
        'Não encontrei uma placa NVIDIA configurada neste computador. ' +
          'A transcrição aqui precisa dela — use a opção "Na nuvem".'
      )
    }

    // Um transcritor vivo segura arquivos do venv; matar antes evita o EPERM.
    stopLocalSpeech(`preparando o ambiente ${runtime}`)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* sobra de instalação anterior: o venv/pip abaixo sobrescreve o que der */
    }
    mkdirSync(dir, { recursive: true })
    // --system-site-packages: herda o torch/CUDA que já existe, em vez de baixar
    // outra stack inteira (uns 4 GB) só para rodar o mesmo modelo.
    await run(base.exe, ['-m', 'venv', '--system-site-packages', dir], getCacheInfo().dir)
    onProgress({ stage: 'preparing', message: 'Instalando os componentes de voz…' })
    await run(
      py,
      ['-m', 'pip', 'install', '--upgrade', '--no-input', ...REQUIREMENTS[runtime]],
      dir,
      (line) => {
        // O pip fala em jargão; só o essencial vira mensagem para o usuário.
        if (/^(Collecting|Downloading|Installing|Building)/i.test(line)) {
          onProgress({ stage: 'preparing', message: 'Instalando os componentes de voz…' })
        }
      }
    )
    // Só agora o ambiente conta como pronto — se o app fechar antes daqui, a
    // próxima abertura refaz em vez de usar uma instalação pela metade.
    writeFileSync(readyMark(dir), REQUIREMENTS[runtime].join(' '), 'utf8')
    return py
  }

  const task = build()
  envPromises.set(runtime, task)
  try {
    return await task
  } finally {
    envPromises.delete(runtime)
  }
}

/**
 * The transcriber, kept alive between dictations so the model loads only once.
 * Speaks both stacks: Parakeet through `transformers`, Canary-Qwen through NeMo
 * (a speech-augmented LLM — it's *prompted* to transcribe, not just decoded).
 */
const WORKER_SOURCE = `
import json, sys, wave, numpy as np, torch

def log(stage, message, percent=None):
    print(json.dumps({"event": stage, "message": message, "percent": percent}), flush=True)

model_id = sys.argv[1]
runtime = sys.argv[2] if len(sys.argv) > 2 else "transformers"
log("start", "")  # o app decide a mensagem: baixar (GBs) ou só carregar (segundos)

if runtime == "nemo":
    from nemo.collections.asr.models import ASRModel
    model = ASRModel.from_pretrained(model_id)
    model.eval()
else:
    from transformers import AutoModel, AutoProcessor
    processor = AutoProcessor.from_pretrained(model_id)
    model = AutoModel.from_pretrained(model_id, dtype=torch.float16).to("cuda").eval()
log("ready", "Reconhecimento de voz pronto.")

def read_wav(path):
    with wave.open(path, "rb") as w:
        frames = w.readframes(w.getnframes())
        audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        if w.getnchannels() > 1:
            audio = audio.reshape(-1, w.getnchannels()).mean(axis=1)
        rate = w.getframerate()
    if rate != 16000:  # o modelo exige 16 kHz mono
        idx = np.linspace(0, len(audio) - 1, int(len(audio) * 16000 / rate))
        audio = np.interp(idx, np.arange(len(audio)), audio).astype(np.float32)
    return audio

def transcribe_nemo(path):
    # O Canary é multilíngue e precisa saber o idioma; sem isso ele "traduz"
    # para inglês e o ditado em português sai errado.
    with torch.inference_mode():
        out = model.transcribe([path], source_lang="pt", target_lang="pt", verbose=False)
    first = out[0]
    return getattr(first, "text", first)

def transcribe_transformers(audio):
    inputs = processor(audio, sampling_rate=16000, return_tensors="pt")
    inputs = {k: (v.to("cuda").half() if v.dtype == torch.float32 else v.to("cuda")) for k, v in inputs.items()}
    with torch.inference_mode():
        out = model.generate(**inputs)
    text = processor.decode(out.sequences[0], skip_special_tokens=True)
    return text[0] if isinstance(text, (list, tuple)) else text

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    try:
        # O NeMo lê o arquivo sozinho; o caminho do transformers precisa das amostras.
        text = (
            transcribe_nemo(req["wav"])
            if runtime == "nemo"
            else transcribe_transformers(read_wav(req["wav"]))
        )
        print(json.dumps({"id": req["id"], "text": str(text).strip()}), flush=True)
    except Exception as exc:  # devolve o erro para o app, sem derrubar o worker
        print(json.dumps({"id": req["id"], "error": str(exc)}), flush=True)
`

/** One message from the worker: a progress event or the answer to a request. */
export interface WorkerMessage {
  event?: string
  message?: string
  percent?: number
  id?: string
  text?: string
  error?: string
}

/**
 * Split whatever arrived on stdout into complete protocol messages, returning
 * the leftover for the next chunk. Python prints library warnings on the same
 * stream, so anything that isn't our JSON is dropped instead of breaking the
 * dictation.
 */
export function parseWorkerChunk(
  buffer: string,
  chunk: string
): { messages: WorkerMessage[]; rest: string } {
  const messages: WorkerMessage[] = []
  let rest = buffer + chunk
  let nl: number
  while ((nl = rest.indexOf('\n')) >= 0) {
    const line = rest.slice(0, nl).trim()
    rest = rest.slice(nl + 1)
    if (!line || !line.startsWith('{')) continue
    try {
      messages.push(JSON.parse(line) as WorkerMessage)
    } catch {
      /* not ours */
    }
  }
  return { messages, rest }
}

interface Worker {
  child: ChildProcessWithoutNullStreams
  model: string
  pending: Map<string, { resolve: (text: string) => void; reject: (e: Error) => void }>
  ready: Promise<void>
}

let worker: Worker | null = null

function startWorker(
  python: string,
  model: string,
  runtime: 'transformers' | 'nemo',
  onProgress: ProgressFn
): Worker {
  const script = join(envDir(runtime), 'asr_worker.py')
  writeFileSync(script, WORKER_SOURCE, 'utf8')
  const child = spawn(python, ['-u', script, model, runtime], { windowsHide: true })
  const pending = new Map<string, { resolve: (text: string) => void; reject: (e: Error) => void }>()

  let markReady: () => void = () => {}
  let markFailed: (e: Error) => void = () => {}
  const ready = new Promise<void>((res, rej) => {
    markReady = res
    markFailed = rej
  })

  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    const parsed = parseWorkerChunk(buffer, chunk.toString())
    buffer = parsed.rest
    for (const msg of parsed.messages) {
      {
        if (msg.event === 'ready') {
          onProgress({ stage: 'done', percent: 100, message: 'Reconhecimento de voz pronto.' })
          markReady()
        } else if (msg.event === 'start') {
          // Baixar são gigabytes; carregar são segundos. Dizer o certo é o que
          // faz o aviso valer alguma coisa.
          const cached = isModelCached(model)
          onProgress({
            stage: cached ? 'loading' : 'downloading',
            message: cached
              ? 'Carregando o reconhecimento de voz…'
              : 'Baixando o reconhecimento de voz (só desta vez)…',
            ...(cached ? {} : { totalMb: localSpeechSizeMb(model) })
          })
        } else if (msg.event) {
          onProgress({
            stage: 'loading',
            message: msg.message ?? 'Preparando o reconhecimento de voz…',
            percent: msg.percent
          })
        } else if (msg.id) {
          const p = pending.get(msg.id)
          pending.delete(msg.id)
          if (!p) continue
          if (msg.error) p.reject(new Error(msg.error))
          else p.resolve(msg.text ?? '')
        }
      }
    }
  })

  // stderr do Python é ruído de biblioteca; só interessa se o processo morrer.
  let stderr = ''
  child.stderr.on('data', (b: Buffer) => {
    stderr = (stderr + b.toString()).slice(-2000)
  })
  const die = (reason: string): void => {
    // O caminho do Python entra na mensagem: quando algo falha aqui, saber QUAL
    // interpretador rodou é a primeira pergunta (e já economizou um diagnóstico).
    const err = new Error(`${reason} [${python}]${lastStopReason ? ` motivo=${lastStopReason}` : ''}`)
    for (const [, p] of pending) p.reject(err)
    pending.clear()
    markFailed(err)
    if (worker?.child === child) worker = null
  }
  child.on('error', (e) => die(e.message))
  child.on('close', (code, signal) =>
    die(
      `${stderr.trim().split('\n').slice(-2).join(' ') || 'O reconhecimento de voz parou.'} (saída=${code} sinal=${signal})`
    )
  )

  return { child, model, pending, ready }
}

/**
 * Transcribe a WAV recorded by the composer, on this machine. First call builds
 * the environment and loads the model (reporting progress); later calls hit the
 * already-loaded worker and return in a couple of seconds.
 */
/** Fila de ditados. Transcrever é sequencial por natureza (uma fala por vez) e
 *  duas chamadas ao mesmo tempo se atropelavam: a que trocava de modelo matava o
 *  transcritor no meio da outra, que voltava com "o reconhecimento parou". */
let queue: Promise<unknown> = Promise.resolve()

export function transcribeLocal(wav: Buffer, model: string, onProgress: ProgressFn): Promise<string> {
  const next = queue.then(
    () => runTranscription(wav, model, onProgress),
    () => runTranscription(wav, model, onProgress)
  )
  // A fila não pode morrer com uma falha: o próximo ditado tem que rodar.
  queue = next.catch(() => undefined)
  return next
}

async function runTranscription(wav: Buffer, model: string, onProgress: ProgressFn): Promise<string> {
  const runtime = localSpeechRuntime(model)
  const python = await ensureEnv(runtime, onProgress)
  if (!worker || worker.model !== model) {
    // Trocar de modelo troca de transcritor, e é preciso ESPERAR o anterior
    // morrer: subir o novo enquanto o antigo ainda segura a VRAM estourava a
    // memória da placa e derrubava o recém-criado (visto ao voltar do modelo
    // grande para o rápido).
    await stopLocalSpeechAndWait(`troca de modelo (${worker?.model ?? "nenhum"} → ${model})`)
    onProgress({ stage: 'loading', message: 'Carregando o reconhecimento de voz…' })
    worker = startWorker(python, model, runtime, onProgress)
  }
  const w = worker
  await w.ready

  const file = join(tmpdir(), `agent-code-dictation-${randomUUID()}.wav`)
  writeFileSync(file, wav)
  const id = randomUUID()
  try {
    return await new Promise<string>((resolve, reject) => {
      w.pending.set(id, { resolve, reject })
      w.child.stdin.write(`${JSON.stringify({ id, wav: file })}\n`)
    })
  } finally {
    rmSync(file, { force: true })
  }
}

/** Por que o transcritor foi encerrado da última vez. Entra na mensagem de erro:
 *  sem isso, um "processo morreu" não diz se foi queda ou se o próprio app o
 *  matou — e foi exatamente essa dúvida que custou caro para diagnosticar. */
let lastStopReason = ''

/** Stop the transcriber (app quitting / engine switched back to cloud). */
export function stopLocalSpeech(reason = 'motivo não informado'): void {
  if (worker) lastStopReason = reason
  worker?.child.kill()
  worker = null
}

/** Same, but waits for the process to actually exit — the GPU only frees its
 *  memory when it does, and the next model needs that room. */
export async function stopLocalSpeechAndWait(reason: string, timeoutMs = 15_000): Promise<void> {
  const dying = worker?.child
  stopLocalSpeech(reason)
  if (!dying || dying.exitCode !== null) return
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    dying.once('close', done)
  })
}
