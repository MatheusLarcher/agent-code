/**
 * Navegador e Android na demonstração (Ctrl+Alt+Shift+D): o turno de um agente
 * que testa a loja no navegador (navigate, print, clique) e o de um que testa o
 * app no Android (instala, toca, digita, print) — o projetor da sala desce,
 * acende e sobe sem conversa real — e a página falsa que o telão mostra no
 * lugar do quadro do navegador (que a demo não tem), pintada em canvas e com
 * o cursor andando a cada desenho.
 */
import { chatPalette, roundRect } from './chatPaint'
import type { DemoTurn, ToolStep } from './demoTimeline'
import type { PageImage } from './projectorPaint'
import type { DeviceKind } from './projectorUse'

const tool = (ms: number, name: string, input: Record<string, unknown>, result: string): ToolStep => ({ do: 'tool', ms, name, input, result })

/** Endereço que o agente da demo abre no navegador. */
export const DEMO_URL = 'http://localhost:5173/carrinho'
export const DEMO_PAGE_TITLE = 'Loja Virtual · Carrinho'
export const DEMO_APP = 'Portal do Aluno'

/** Testa o carrinho no navegador (sala da loja). */
export function browserTurn(at: number): DemoTurn {
  return {
    at,
    user: 'Abre a loja no navegador e confere se o carrinho soma o frete.',
    steps: [
      tool(3_000, 'mcp__browser__browser_navigate', { url: DEMO_URL }, `Navegou para ${DEMO_URL} — "${DEMO_PAGE_TITLE}" (aba: "web - ${DEMO_PAGE_TITLE}").`),
      tool(2_500, 'mcp__browser__browser_screenshot', {}, '[image]'),
      tool(2_500, 'mcp__browser__browser_click', { selector: 'button.finalizar' }, 'Clicou em button.finalizar.'),
      tool(2_000, 'mcp__browser__browser_screenshot', {}, '[image]'),
      { do: 'answer', text: 'Abri a loja: o carrinho soma o frete certinho e o **Finalizar** leva ao checkout.' }
    ]
  }
}

/** Testa o login do app no Android (sala do portal). */
export function androidTurn(at: number, cwd: string): DemoTurn {
  return {
    at,
    user: 'Instala o app do portal no Android e testa o login.',
    steps: [
      tool(3_500, 'mcp__android__android_install_run', { apkPath: `${cwd}\\android\\app\\build\\outputs\\apk\\debug\\app-debug.apk`, appName: DEMO_APP }, `APK instalado (br.edu.portal) e iniciado no preview "android - ${DEMO_APP}".`),
      tool(2_000, 'mcp__android__android_tap', { nx: 0.5, ny: 0.42 }, 'Toque em (0.500, 0.420).'),
      tool(2_000, 'mcp__android__android_type', { text: 'aluno@itp.edu.br' }, 'Texto digitado.'),
      tool(2_500, 'mcp__android__android_screenshot', {}, '[image]'),
      { do: 'answer', text: 'O login do app funciona: entrei e as notas aparecem na tela inicial.' }
    ]
  }
}

type Ctx = CanvasRenderingContext2D

/** Seta do mouse em (x, y). */
function cursor(ctx: Ctx, x: number, y: number, s: number): void {
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = '#111111'
  ctx.lineWidth = 1.2 * s
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x, y + 16 * s)
  ctx.lineTo(x + 4.5 * s, y + 12 * s)
  ctx.lineTo(x + 11 * s, y + 12 * s)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
}

/** O carrinho da loja: itens, frete, total e o botão — o cursor vai até o "Finalizar". */
function paintShop(ctx: Ctx, x: number, y: number, w: number, h: number, t: number): void {
  const s = w / 640
  const p = chatPalette()
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = '#1f6feb'
  ctx.fillRect(x, y, w, 40 * s)
  ctx.fillStyle = '#ffffff'
  ctx.font = `700 ${Math.round(16 * s)}px ${p.font}`
  ctx.textBaseline = 'middle'
  ctx.fillText('Loja Virtual', x + 18 * s, y + 20 * s)
  ctx.fillStyle = '#1b1f24'
  ctx.font = `700 ${Math.round(15 * s)}px ${p.font}`
  ctx.fillText('Seu carrinho', x + 18 * s, y + 64 * s)
  const items: Array<[string, string]> = [['Camiseta dev', 'R$ 79,90'], ['Caneca "funciona na minha máquina"', 'R$ 39,90'], ['Adesivos (kit)', 'R$ 19,90']]
  ctx.font = `${Math.round(12.5 * s)}px ${p.font}`
  items.forEach(([name, price], i) => {
    const ry = y + (92 + i * 34) * s
    ctx.fillStyle = '#eef2f7'
    roundRect(ctx, x + 18 * s, ry - 13 * s, w * 0.56, 26 * s, 6 * s)
    ctx.fill()
    ctx.fillStyle = '#1b1f24'
    ctx.fillText(name, x + 28 * s, ry)
    ctx.fillText(price, x + 18 * s + w * 0.56 - 70 * s, ry)
  })
  const bx = x + w * 0.66
  ctx.fillStyle = '#f6f8fa'
  roundRect(ctx, bx, y + 78 * s, w * 0.3, 150 * s, 8 * s)
  ctx.fill()
  ctx.fillStyle = '#57606a'
  ctx.fillText('Frete', bx + 14 * s, y + 104 * s)
  ctx.fillText('R$ 12,00', bx + w * 0.3 - 74 * s, y + 104 * s)
  ctx.fillStyle = '#1b1f24'
  ctx.font = `700 ${Math.round(14 * s)}px ${p.font}`
  ctx.fillText('Total', bx + 14 * s, y + 136 * s)
  ctx.fillText('R$ 151,70', bx + w * 0.3 - 90 * s, y + 136 * s)
  const btn = { x: bx + 14 * s, y: y + 166 * s, w: w * 0.3 - 28 * s, h: 34 * s }
  ctx.fillStyle = '#2da44e'
  roundRect(ctx, btn.x, btn.y, btn.w, btn.h, 8 * s)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.fillText('Finalizar', btn.x + btn.w / 2 - 30 * s, btn.y + btn.h / 2)
  // O cursor sai do meio da página e vai até o botão (vai e volta).
  const k = (Math.sin(t / 900) + 1) / 2
  cursor(ctx, x + w * 0.3 + (btn.x + btn.w / 2 - x - w * 0.3) * k, y + h * 0.75 + (btn.y + btn.h / 2 - y - h * 0.75) * k, s)
}

/** A tela de login do app, com o e-mail sendo digitado. */
function paintApp(ctx: Ctx, x: number, y: number, w: number, h: number, t: number): void {
  const s = w / 300
  const p = chatPalette()
  ctx.fillStyle = '#f4f6fb'
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = '#2e9d6a'
  ctx.fillRect(x, y, w, 64 * s)
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'middle'
  ctx.font = `700 ${Math.round(17 * s)}px ${p.font}`
  ctx.fillText(DEMO_APP, x + 16 * s, y + 42 * s)
  const email = 'aluno@itp.edu.br'
  const typed = email.slice(0, Math.min(email.length, Math.floor((t / 250) % (email.length + 8))))
  const field = (fy: number, label: string, value: string): void => {
    ctx.fillStyle = '#5b6372'
    ctx.font = `${Math.round(11 * s)}px ${p.font}`
    ctx.fillText(label, x + 18 * s, fy - 12 * s)
    ctx.fillStyle = '#ffffff'
    roundRect(ctx, x + 16 * s, fy, w - 32 * s, 34 * s, 8 * s)
    ctx.fill()
    ctx.fillStyle = '#1b1f24'
    ctx.font = `${Math.round(13 * s)}px ${p.font}`
    ctx.fillText(value, x + 26 * s, fy + 17 * s)
  }
  field(y + h * 0.36, 'E-mail', `${typed}|`)
  field(y + h * 0.36 + 70 * s, 'Senha', '••••••••')
  ctx.fillStyle = '#2e9d6a'
  roundRect(ctx, x + 16 * s, y + h * 0.36 + 134 * s, w - 32 * s, 40 * s, 10 * s)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = `700 ${Math.round(14 * s)}px ${p.font}`
  ctx.fillText('Entrar', x + w / 2 - 22 * s, y + h * 0.36 + 154 * s)
}

/** A "página" que o telão da demo mostra, no instante `t` (ms): a loja (web) ou o app (Android). */
export function demoPage(kind: DeviceKind, t: number): PageImage {
  return kind === 'android'
    ? { width: 1080, height: 2340, draw: (ctx, x, y, w, h) => paintApp(ctx, x, y, w, h, t) }
    : { width: 1280, height: 720, draw: (ctx, x, y, w, h) => paintShop(ctx, x, y, w, h, t) }
}
