import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { z as z3 } from 'zod/v3'
import type { ZodType } from 'zod'
import type { UiMockupArtifact } from '../shared/ipc'
import {
  latestUiMockupSeeds,
  MAX_UI_MOCKUP_TITLE,
  normalizeUiMockupTitle
} from '../shared/uiMockup'
import {
  MAX_MOCKUP_SOURCE,
  UiMockupValidationError,
  WireMdMockupRenderer,
  type UiMockupRenderer
} from './wiremdRenderer'

const MAX_TITLE = MAX_UI_MOCKUP_TITLE
const FINAL_ERROR = 'Não consegui renderizar este mockup.'

// The MCP runtime supports Zod 3 and preserves its JSON-schema constraints,
// while the Claude SDK helper currently types only Zod 4 shapes. Keep this
// compatibility cast at the registration boundary; runtime schemas stay v3.
const mcpInput = <T extends z3.ZodTypeAny>(schema: T): ZodType => schema as unknown as ZodType

// `.catch()` deliberately keeps malformed/missing values inside the handler so
// they consume the retry budget. Zod otherwise advertises caught fields as
// optional, so override only its JSON-schema requiredness signal.
const requiredMcpInput = <T extends z3.ZodTypeAny>(schema: T): ZodType => {
  Object.defineProperty(schema, 'isOptional', { value: () => false })
  return mcpInput(schema)
}

type ToolText = {
  content: { type: 'text'; text: string }[]
  isError?: boolean
  _meta?: Record<string, unknown>
}
type ArtifactSeed = Pick<UiMockupArtifact, 'id' | 'version' | 'title' | 'source' | 'viewport'>

const text = (
  value: unknown,
  isError = false,
  meta?: Record<string, unknown>
): ToolText => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
  ...(meta ? { _meta: meta } : {})
})

export const RENDER_UI_MOCKUP_DESCRIPTION =
  'Renderiza um único mockup visual compacto usando WireMD. Use quando o usuário pedir para ver, desenhar, visualizar, prototipar ou alterar visualmente uma tela, interface, página, dashboard, formulário ou aplicativo. Não use para explicações, arquitetura, análise de UX, perguntas apenas conceituais ou implementação em código sem intenção visual explícita. Quando usar esta tool, o mockup deve ser a resposta principal e não deve ser substituído por uma descrição textual da tela.'

function artifactKey(title: string): string {
  return normalizeUiMockupTitle(title)
}

function pendingArtifactKey(id: string, version: number): string {
  return `${id}:${version}`
}

function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof UiMockupValidationError) return { code: error.code, message: error.message }
  if (error instanceof Error) return { code: 'RENDER_FAILED', message: error.message.slice(0, 500) }
  return { code: 'RENDER_FAILED', message: String(error).slice(0, 500) }
}

function parseInput(
  rawTitle: unknown,
  rawSource: unknown,
  rawViewport: unknown
): { title: string; source: string; viewport: 'desktop' | 'mobile' } {
  if (typeof rawTitle !== 'string') {
    throw new UiMockupValidationError('Mockup title must be a string.', 'INVALID_TITLE')
  }
  const title = rawTitle.trim()
  if (!title || title.length > MAX_TITLE || /[\u0000-\u001f\u007f]/.test(title)) {
    throw new UiMockupValidationError(
      'Mockup title is required, must have at most 80 characters, and cannot contain control characters.',
      'INVALID_TITLE'
    )
  }
  if (typeof rawSource !== 'string') {
    throw new UiMockupValidationError('WireMD source must be a string.', 'INVALID_SOURCE')
  }
  if (!rawSource.trim() || rawSource.length > MAX_MOCKUP_SOURCE) {
    throw new UiMockupValidationError(
      'WireMD source is required and must have at most 2,500 characters.',
      'INVALID_SOURCE'
    )
  }
  const viewport = rawViewport === undefined ? 'desktop' : rawViewport
  if (viewport !== 'desktop' && viewport !== 'mobile') {
    throw new UiMockupValidationError('Mockup viewport must be desktop or mobile.', 'INVALID_VIEWPORT')
  }
  return { title, source: rawSource, viewport }
}

export class UiMockupToolController {
  readonly server: ReturnType<typeof createSdkMcpServer>
  private readonly artifacts = new Map<string, ArtifactSeed>()
  private readonly pendingArtifacts = new Map<string, UiMockupArtifact>()
  private failuresThisTurn = 0
  private successfulRendersThisTurn = 0
  /** MCP may dispatch sibling tool calls concurrently. Serialize the complete
   *  render/version transaction so caps, ids and versions remain atomic. */
  private renderQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly renderer: UiMockupRenderer,
    seeds: ArtifactSeed[] = []
  ) {
    // StartAgentOptions carries chronological seeds. The shared helper validates,
    // deduplicates and returns newest-first; insert oldest-first so Map order is
    // an LRU while `seeds()` can expose the active set newest-first.
    const activeSeeds = latestUiMockupSeeds(seeds)
    for (const seed of activeSeeds.reverse()) {
      const key = artifactKey(seed.title)
      this.artifacts.set(key, {
        id: seed.id,
        version: seed.version,
        title: seed.title,
        source: seed.source,
        viewport: seed.viewport
      })
    }
    this.server = createSdkMcpServer({
      name: 'wiremd',
      version: '0.6.1',
      tools: [
        tool(
          'render_ui_mockup',
          RENDER_UI_MOCKUP_DESCRIPTION,
          {
            // Keep the MCP schema permissive and enforce the advertised
            // constraints inside the controller. Schema-level failures happen
            // before the handler and would otherwise bypass the one-retry lock.
            title: requiredMcpInput(z3.string().min(1).max(MAX_TITLE).catch('')
              .describe('String obrigatória, curta e estável, com no máximo 80 caracteres.')),
            source: requiredMcpInput(z3.string().min(1).max(MAX_MOCKUP_SOURCE).catch('')
              .describe('String WireMD 0.6.1 obrigatória, com no máximo 2.500 caracteres, sem HTML, JSX ou JavaScript.')),
            // `.catch()` keeps malformed values inside the controller's retry
            // policy while the MCP schema still advertises the exact enum.
            viewport: mcpInput(z3.enum(['desktop', 'mobile']).optional()
              .catch('__invalid_wiremd_viewport__' as 'desktop')
              .default('desktop')
              .describe('"desktop" (padrão) ou "mobile".'))
          },
          async ({ title, source, viewport }) => this.render(title, source, viewport)
        )
      ]
    })
  }

  beginTurn(): void {
    this.failuresThisTurn = 0
    this.successfulRendersThisTurn = 0
  }

  seeds(): ArtifactSeed[] {
    return [...this.artifacts.values()].reverse().map((artifact) => ({
      id: artifact.id,
      version: artifact.version,
      title: artifact.title,
      source: artifact.source,
      viewport: artifact.viewport
    }))
  }

  takePendingArtifact(id: string, version: number): UiMockupArtifact | undefined {
    const key = pendingArtifactKey(id, version)
    const artifact = this.pendingArtifacts.get(key)
    if (artifact) this.pendingArtifacts.delete(key)
    return artifact
  }

  private render(rawTitle: unknown, rawSource: unknown, rawViewport: unknown): Promise<ToolText> {
    const queued = this.renderQueue.then(
      () => this.renderExclusive(rawTitle, rawSource, rawViewport),
      () => this.renderExclusive(rawTitle, rawSource, rawViewport)
    )
    this.renderQueue = queued.then(() => undefined, () => undefined)
    return queued
  }

  private async renderExclusive(rawTitle: unknown, rawSource: unknown, rawViewport: unknown): Promise<ToolText> {
    if (this.failuresThisTurn >= 2) {
      return text({ ok: false, retryAllowed: false, message: FINAL_ERROR }, true)
    }
    if (this.successfulRendersThisTurn >= 3) {
      return text({
        ok: false,
        retryAllowed: false,
        code: 'TOO_MANY_SCREENS',
        message: 'No máximo três mockups compactos podem ser renderizados no mesmo turno.'
      }, true)
    }
    try {
      const { title, source, viewport } = parseInput(rawTitle, rawSource, rawViewport)
      const key = artifactKey(title)
      const previous = this.artifacts.get(key)
      if (previous && previous.version >= Number.MAX_SAFE_INTEGER) {
        throw new UiMockupValidationError(
          'This mockup reached the maximum safe version and cannot be incremented.',
          'VERSION_EXHAUSTED'
        )
      }
      const rendered = await this.renderer.render(source)
      const artifact: UiMockupArtifact = {
        type: 'ui_mockup',
        id: previous?.id ?? randomUUID(),
        version: (previous?.version ?? 0) + 1,
        title,
        source: rendered.source,
        html: rendered.html,
        viewport
      }
      // Store only the editable seed in session state. The full HTML belongs
      // exclusively to the bounded pending map until its SDK result arrives.
      this.artifacts.delete(key)
      this.artifacts.set(key, {
        id: artifact.id,
        version: artifact.version,
        title: artifact.title,
        source: artifact.source,
        viewport: artifact.viewport
      })
      this.pendingArtifacts.set(pendingArtifactKey(artifact.id, artifact.version), artifact)
      while (this.pendingArtifacts.size > 12) {
        const oldest = this.pendingArtifacts.keys().next().value
        if (typeof oldest !== 'string') break
        this.pendingArtifacts.delete(oldest)
      }
      this.successfulRendersThisTurn++
      return text({
        ok: true,
        type: artifact.type,
        id: artifact.id,
        version: artifact.version,
        title: artifact.title,
        source: artifact.source,
        viewport: artifact.viewport
      }, false, { 'agent-code/ui-mockup': { ...artifact } })
    } catch (error) {
      this.failuresThisTurn++
      const detail = safeError(error)
      console.error('[render_ui_mockup]', detail.code, error)
      if (this.failuresThisTurn === 1) {
        return text({
          ok: false,
          retryAllowed: true,
          code: detail.code,
          error: detail.message,
          instruction: 'Simplifique e corrija o source WireMD uma única vez.'
        }, true)
      }
      return text({ ok: false, retryAllowed: false, message: FINAL_ERROR }, true)
    }
  }
}

export function createWiremdMockupController(
  seeds: ArtifactSeed[] = [],
  renderer: UiMockupRenderer = new WireMdMockupRenderer()
): UiMockupToolController {
  return new UiMockupToolController(renderer, seeds)
}

export { FINAL_ERROR, MAX_TITLE, artifactKey }
export { validateWiremdSource } from './wiremdRenderer'
