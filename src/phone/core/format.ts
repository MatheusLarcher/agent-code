/** Formatação curta para a tela do celular (datas, bytes, tokens, uso da conta). */

/** "Hoje às 14:32" ou "30/06/2026 às 14:32". */
export function fmtMsgTime(ts: number, now = new Date()): string {
  const d = new Date(ts)
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? `Hoje às ${time}` : `${d.toLocaleDateString('pt-BR')} às ${time}`
}

export function fmtBytes(n: number): string {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
  if (n >= 1024) return Math.round(n / 1024) + ' KB'
  return n + ' B'
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1e3) return Math.round(n / 1e3) + 'k'
  return String(n || 0)
}

/** Quando a janela de uso reseta (`resetsAt` em segundos ou ms). */
export function fmtReset(ts: number | undefined, now = Date.now()): string {
  if (!ts) return ''
  const ms = ts * (ts < 1e12 ? 1000 : 1) - now
  if (ms <= 0) return 'já resetou'
  const m = Math.round(ms / 60000)
  if (m < 60) return `reseta em ${m} min`
  const h = Math.round(m / 60)
  if (h < 48) return `reseta em ${h} h`
  return `reseta em ${Math.round(h / 24)} dias`
}

export const USAGE_LABELS: Record<string, string> = {
  five_hour: 'Claude · sessão 5h',
  seven_day: 'Claude · semana',
  seven_day_opus: 'Claude · semana Opus',
  seven_day_sonnet: 'Claude · semana Sonnet',
  seven_day_overage_included: 'Claude · excedente incluído',
  overage: 'Claude · excedente',
  gpt_primary: 'GPT · janela curta',
  gpt_secondary: 'GPT · janela longa'
}

/** Último segmento de um caminho (/ ou \). */
export function basename(p: string | undefined | null): string {
  const parts = (p || '').split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || p || '—'
}

/** "{{midia:N}}" (anexo posto no meio do texto no PC) → "[mídia N]". */
export function readableMedia(text: string): string {
  return String(text).replace(/\{\{midia:(\d{1,4})\}\}/g, '[mídia $1]')
}

/** Tira os marcadores `[[download:CAMINHO]]` do texto → { texto limpo, caminhos }. */
export function parseDownloads(text: string | undefined): { clean: string; paths: string[] } {
  const paths: string[] = []
  const clean = String(text || '')
    .replace(/\[\[download:\s*([^\]\n]+?)\s*\]\]/g, (_, p: string) => {
      const path = p.trim()
      if (path) paths.push(path)
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { clean, paths }
}

export function questionPreview(text: string | undefined): string {
  const clean = (text || '').trim().replace(/\s+/g, ' ')
  return clean.length > 130 ? clean.slice(0, 130) + '...' : clean || '(imagem/anexo)'
}

export function clipText(text: string | undefined, max: number): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/** "Sem resposta há 1min 5s". */
export function fmtElapsed(since: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - since) / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}min ${s % 60}s` : `${s}s`
}
