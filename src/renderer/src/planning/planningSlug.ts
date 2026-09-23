/**
 * Slug de um planejamento novo, derivado do título digitado.
 *
 * O main aceita só [a-z0-9-] com 1 a 64 caracteres (planningModel.NAME_RE) e
 * recusa criar por cima de um plano existente — então o slug sai daqui já
 * nesse formato e único contra a lista da pasta (planningList), com sufixo
 * -2, -3… na colisão. O main continua sendo a fronteira: isto só evita pedir
 * o que ele vai recusar.
 */

export const PLANNING_SLUG_MAX = 64

/** Título → [a-z0-9-]: sem acento (NFD), minúsculo, o resto vira '-', até 64. */
export function slugFromTitle(titulo: string): string {
  return titulo
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PLANNING_SLUG_MAX)
    .replace(/-+$/, '')
}

/** `base` se estiver livre; senão base-2, base-3… cortando a base para caber em 64. */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const head = base.slice(0, PLANNING_SLUG_MAX - suffix.length).replace(/-+$/, '')
    const candidate = `${head}${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

/** O slug do plano novo, ou '' quando o título não tem letra nem número. */
export function derivePlanningSlug(titulo: string, taken: Iterable<string>): string {
  const base = slugFromTitle(titulo)
  return base ? uniqueSlug(base, taken) : ''
}

/**
 * Slug de um plano criado SEM pedir nome: `plano-AAAAMMDD-HHMM` na hora local
 * de `now`, único contra `taken` (-2, -3… quando dois nascem no mesmo minuto).
 * É gerado uma vez, no clique, e não muda depois: o nome do plano (título do
 * roteiro) vem da conversa, a pasta fica.
 */
export function generatePlanningSlug(now: Date, taken: Iterable<string>): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`
  return uniqueSlug(`plano-${stamp}`, taken)
}
