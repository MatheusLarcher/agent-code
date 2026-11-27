/**
 * PowerPoint no Preview: o main já desmontou o .pptx em formas com posição
 * relativa (fração do slide); aqui cada slide vira um palco com aspect-ratio
 * do original e `container-type: inline-size`, e tudo dentro é medido em %
 * (posição) e cqw (fonte, borda, margem interna). Assim o mesmo componente
 * desenha o slide grande e as miniaturas, sem medir nada no JS.
 *
 * Navegação: Anterior/Próxima, setas/PageUp/PageDown/Home/End com o foco no
 * visualizador, e a faixa de miniaturas. Anotações do apresentador abaixo.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from 'react'
import { PREVIEW_LIMITS, type PreviewFileOk, type PreviewParagraph, type PreviewShape, type PreviewSlide } from '@shared/preview'
import { IconChevronLeft, IconChevronRight } from '../../components/Icons'
import { ViewerNotice } from './ViewerNotice'
import './viewers.css'

type SlidesResult = Extract<PreviewFileOk, { kind: 'slides' }>
type Images = Record<string, string>
type TextBox = Extract<PreviewShape, { type: 'box' }>

/** 1 pt = 12700 EMU; recuo de um nível de lista = 0,5" (457200 EMU), como no PowerPoint. */
const EMU_PT = 12700
const EMU_INDENT = 457200

// ── Validação na fronteira (o resultado veio do main pelo IPC) ──

const okNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const color = (c: string | undefined): string | undefined => (c && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c) ? c : undefined)
/** Só data URL de imagem vira src (nada de arquivo ou http vindo do pptx). */
const imageSrc = (images: Images, key: string | undefined): string | undefined => {
  const v = key ? images[key] : undefined
  return typeof v === 'string' && v.startsWith('data:image/') ? v : undefined
}
const fontFamily = (f: string | undefined): string | undefined => (f ? `"${f.replace(/["\\;]/g, '')}", sans-serif` : undefined)
const validShape = (s: PreviewShape): boolean => [s.x, s.y, s.w, s.h].every(okNum)

/** Converte medidas do slide para cqw (a largura do palco é 100cqw). */
interface Scale {
  pt(pt: number): string
  frac(f: number): string
  emu(e: number): string
}
function scaleFor(width: number): Scale {
  const emu = (e: number): string => `${((e / width) * 100).toFixed(4)}cqw`
  return { emu, pt: (pt) => emu(pt * EMU_PT), frac: (f) => `${(f * 100).toFixed(4)}cqw` }
}
/** Caixa com ajuste automático: o que é medido em pt (fonte, entrelinha, espaços) multiplica por --pv-fit. */
const fitted = (sc: Scale): Scale => ({ ...sc, pt: (pt) => `calc(${sc.pt(pt)} * var(--pv-fit, 1))` })

/**
 * Maior escala de fonte em [min, 1] com que o texto cabe (busca binária). `fits(f)` aplica a escala e mede.
 * Pura para dar para testar sem layout.
 */
export function chooseFit(fits: (f: number) => boolean, min = 0.25, steps = 7): number {
  if (fits(1)) return 1
  if (!fits(min)) return min
  let [lo, hi] = [min, 1]
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }
  return Math.floor(lo * 1000) / 1000
}

/**
 * Encolhe a fonte da caixa até caber na altura, como o normAutofit do PowerPoint. Escreve --pv-fit direto no
 * elemento (sem estado do React, então não há re-render nem laço) e mede de novo quando a caixa muda de tamanho.
 * A caixa tem tamanho fixo (inset 0), então mudar a fonte não dispara o ResizeObserver de novo.
 */
function useAutofit(ref: RefObject<HTMLDivElement | null>, on: boolean, deps: unknown): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !on) return
    // Só escreve quando a escala muda: caixa que já cabe custa uma leitura, sem forçar novo layout
    // (o deck tem centenas de caixas com autofit, contando as miniaturas). Sem a variável = 1.
    let cur = Number(el.style.getPropertyValue('--pv-fit')) || 1
    const apply = (f: number): void => {
      if (f === cur) return
      cur = f
      el.style.setProperty('--pv-fit', String(f))
    }
    let size = ''
    const run = (): void => {
      const now = `${el.clientWidth}x${el.clientHeight}`
      if (now === size || el.clientHeight <= 0) return
      size = now
      apply(chooseFit((f) => (apply(f), el.scrollHeight <= el.clientHeight + 1)))
    }
    run()
    if (typeof ResizeObserver === 'undefined') return
    // O observer também avisa logo ao observar: o mesmo tamanho não mede de novo.
    const ro = new ResizeObserver(run)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, on, deps])
}

// ── Um slide (grande ou miniatura) ──

function boxStyle(s: PreviewShape, flipH?: boolean, flipV?: boolean): CSSProperties {
  const t = [s.rot ? `rotate(${s.rot}deg)` : '', flipH || flipV ? `scale(${flipH ? -1 : 1}, ${flipV ? -1 : 1})` : ''].join(' ').trim()
  return { left: `${s.x * 100}%`, top: `${s.y * 100}%`, width: `${s.w * 100}%`, height: `${s.h * 100}%`, ...(t ? { transform: t } : {}) }
}

function Paragraph({ p, sc }: { p: PreviewParagraph; sc: Scale }): JSX.Element {
  const base = p.size ?? p.runs.find((r) => okNum(r.size))?.size ?? 18
  const style: CSSProperties = { textAlign: p.align ?? 'left', fontSize: sc.pt(base) }
  if (p.level) style.paddingLeft = sc.emu(p.level * EMU_INDENT)
  // 100% no PowerPoint = espaçamento simples = 1,2 × a fonte (o line-height do palco).
  if (okNum(p.linePt) && p.linePt > 0) style.lineHeight = sc.pt(p.linePt)
  else if (okNum(p.lineH) && p.lineH > 0) style.lineHeight = (p.lineH * 1.2).toFixed(4)
  if (okNum(p.before) && p.before > 0) style.marginTop = sc.pt(p.before)
  if (okNum(p.after) && p.after > 0) style.marginBottom = sc.pt(p.after)
  return (
    <p className="pv-sl-p" style={style}>
      {p.bullet && <span className="pv-sl-bullet">{p.bullet}</span>}
      {p.runs.length === 0 && '\u00a0'}
      {p.runs.map((r, i) => (
        <span
          key={i}
          style={{
            fontSize: okNum(r.size) ? sc.pt(r.size) : undefined,
            fontWeight: r.bold ? 700 : undefined,
            fontStyle: r.italic ? 'italic' : undefined,
            textDecoration: r.underline ? 'underline' : undefined,
            color: color(r.color),
            fontFamily: fontFamily(r.font),
            letterSpacing: okNum(r.spacing) && r.spacing !== 0 ? sc.pt(r.spacing) : undefined
          }}
        >
          {r.text}
        </span>
      ))}
    </p>
  )
}

function Box({ s, sc, width, height }: { s: TextBox; sc: Scale; width: number; height: number }): JSX.Element {
  const style: CSSProperties = { ...boxStyle(s), background: color(s.fill) }
  const line = color(s.line)
  if (line && okNum(s.lineW)) style.border = `max(1px, ${sc.frac(s.lineW)}) solid ${line}`
  if (s.geom === 'ellipse') style.borderRadius = '50%'
  // Retângulo arredondado: o PowerPoint usa 1/6 do lado menor.
  else if (s.geom === 'round') style.borderRadius = sc.frac(Math.min(s.w, (s.h * height) / width) / 6)
  const t = s.text
  const auto = t?.autofit === true
  const text = useRef<HTMLDivElement>(null)
  useAutofit(text, auto, t)
  const psc = auto ? fitted(sc) : sc
  return (
    <div className="pv-sl-shape" style={style}>
      {t && t.paragraphs.length > 0 && (
        <div ref={text} className={`pv-sl-text ${t.anchor}${t.noWrap === true ? ' nowrap' : ''}`} style={{ padding: t.pad.map((v) => sc.frac(okNum(v) ? v : 0)).join(' ') }}>
          {t.paragraphs.map((p, i) => (
            <Paragraph key={i} p={p} sc={psc} />
          ))}
        </div>
      )}
    </div>
  )
}

function Shape({ s, images, sc, width, height }: { s: PreviewShape; images: Images; sc: Scale; width: number; height: number }): JSX.Element | null {
  switch (s.type) {
    case 'box':
      return <Box s={s} sc={sc} width={width} height={height} />
    case 'image': {
      const src = imageSrc(images, s.image)
      if (!src) return <Missing s={s} label="Imagem" />
      return <img className="pv-sl-shape pv-sl-img" style={boxStyle(s, s.flipH, s.flipV)} src={src} alt="" draggable={false} />
    }
    case 'line': {
      const stroke = color(s.line) ?? '#000000'
      const [y1, y2] = s.flipV ? ['100%', '0'] : ['0', '100%']
      const [x1, x2] = s.flipH ? ['100%', '0'] : ['0', '100%']
      return (
        <svg className="pv-sl-shape pv-sl-line" style={boxStyle(s)} aria-hidden="true">
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} style={{ strokeWidth: `max(1px, ${sc.frac(okNum(s.lineW) ? s.lineW : 0)})` }} />
        </svg>
      )
    }
    case 'table':
      return (
        <div className="pv-sl-shape pv-sl-table" style={{ ...boxStyle(s), fontSize: sc.pt(okNum(s.size) ? s.size : 14), color: color(s.color) }}>
          <table>
            <tbody>
              {s.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((c, i) => (
                    <td key={i}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'missing':
      return <Missing s={s} label={s.label} />
    default:
      return null
  }
}

function Missing({ s, label }: { s: PreviewShape; label: string }): JSX.Element {
  return (
    <div className="pv-sl-shape pv-sl-missing" style={boxStyle(s)} data-tip={`${label}: o preview não desenha este item`}>
      <span>{label}</span>
    </div>
  )
}

interface CanvasProps {
  slide: PreviewSlide
  images: Images
  width: number
  height: number
  label?: string
}

/** Memo: trocar de slide não redesenha as miniaturas. */
const SlideCanvas = memo(function SlideCanvas({ slide, images, width, height, label }: CanvasProps): JSX.Element {
  const sc = scaleFor(width)
  const bgImg = imageSrc(images, slide.backgroundImage)
  const style: CSSProperties = {
    aspectRatio: `${width} / ${height}`,
    backgroundColor: color(slide.background) ?? '#ffffff',
    ...(bgImg ? { backgroundImage: `url("${bgImg}")` } : {})
  }
  return (
    <div className="pv-sl-canvas" style={style} role={label ? 'img' : undefined} aria-label={label}>
      {(Array.isArray(slide.shapes) ? slide.shapes : []).filter(validShape).map((s, i) => (
        <Shape key={i} s={s} images={images} sc={sc} width={width} height={height} />
      ))}
    </div>
  )
})

// ── O visualizador ──

export function SlidesView({ result }: { result: SlidesResult }): JSX.Element {
  const slides = Array.isArray(result.slides) ? result.slides : []
  const images = result.images && typeof result.images === 'object' ? result.images : {}
  // Tamanho inválido cai no 16:9 do PowerPoint.
  const ok = okNum(result.width) && okNum(result.height) && result.width > 0 && result.height > 0
  const [width, height] = ok ? [result.width, result.height] : [12192000, 6858000]
  const [index, setIndex] = useState(0)
  const current = Math.min(index, Math.max(0, slides.length - 1))
  const strip = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>('[aria-current="true"]')
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [current])

  if (!slides.length) return <p className="pv-empty">Esta apresentação não tem slides.</p>

  const go = (i: number): void => setIndex(Math.max(0, Math.min(slides.length - 1, i)))
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, PageUp: -1, ArrowRight: 1, ArrowDown: 1, PageDown: 1 }
    if (e.key in step) go(current + step[e.key])
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(slides.length - 1)
    else return
    e.preventDefault()
  }
  const slide = slides[current]
  const notes = typeof slide.notes === 'string' ? slide.notes.trim() : ''

  return (
    <div className="pv-slides" tabIndex={0} onKeyDown={onKey} aria-label="Apresentação" aria-roledescription="apresentação de slides">
      {result.truncated && <ViewerNotice>Mostrando só os primeiros {PREVIEW_LIMITS.pptxSlides} slides.</ViewerNotice>}
      <div className="pv-sl-stage" style={{ '--pv-sl-ar': width / height } as CSSProperties}>
        <div className="pv-sl-main">
          {/* key: slide novo = elementos novos; a marca do Selecionar não fica sobre a forma de outro slide. */}
          <SlideCanvas key={current} slide={slide} images={images} width={width} height={height} label={`Slide ${current + 1}`} />
        </div>
      </div>
      <div className="pv-pager pv-sl-bar">
        <button type="button" className="pv-btn" onClick={() => go(current - 1)} disabled={current === 0} data-tip="Slide anterior (←)">
          <IconChevronLeft size={14} aria-hidden="true" />
          Anterior
        </button>
        <span className="pv-page" aria-live="polite">
          Slide {current + 1} de {slides.length}
        </span>
        {slide.hidden && (
          <span className="pv-sl-tag" data-tip="Marcado como oculto: não aparece na apresentação">
            Oculto
          </span>
        )}
        <button type="button" className="pv-btn" onClick={() => go(current + 1)} disabled={current === slides.length - 1} data-tip="Próximo slide (→)">
          Próxima
          <IconChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
      {slides.length > 1 && (
        <div className="pv-sl-strip pv-scroll" ref={strip} aria-label="Miniaturas dos slides">
          {slides.map((s, i) => (
            <button
              key={i}
              type="button"
              className={`pv-sl-thumb${i === current ? ' active' : ''}${s.hidden ? ' hidden' : ''}`}
              aria-current={i === current}
              aria-label={`Ir para o slide ${i + 1}${s.hidden ? ' (oculto)' : ''}`}
              onClick={() => go(i)}
            >
              <SlideCanvas slide={s} images={images} width={width} height={height} />
              <span className="pv-sl-num">{i + 1}</span>
            </button>
          ))}
        </div>
      )}
      {notes && (
        <section className="pv-sl-notes" aria-label="Anotações do apresentador">
          <h4>Anotações</h4>
          <div className="pv-sl-notes-body pv-scroll">{notes}</div>
        </section>
      )}
    </div>
  )
}
