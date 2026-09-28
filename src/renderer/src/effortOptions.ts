/**
 * As opções de modelo e esforço que os seletores oferecem (chat principal,
 * Agent Manager e o catálogo do celular), fora do App.tsx para serem testáveis.
 *
 * Modelo e esforço são Automáticos de forma independente, e as duas opções
 * Automático só aparecem com o TypeSafe configurado — a não ser que já sejam o
 * valor gravado: aí continuam visíveis, porque nada troca a escolha salva por
 * conta própria (sem TypeSafe o main aplica o recuo dele).
 */
import { AUTO_EFFORT, AUTO_MODEL, AUTO_MODEL_OPTION, isAutoEffort, isAutoModel, MODEL_EFFORT } from '@shared/ipc'
import { effortLadderFor, isEffortLevel } from '@shared/autoEffort'

export const EFFORT_LABELS: Record<string, string> = {
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  xhigh: 'Extra alto',
  max: 'Máximo'
}

/** Rótulo da posição/valor Automático do esforço. */
export const AUTO_EFFORT_LABEL = 'Automático'

export interface EffortOption {
  value: string
  label: string
}

/** Os níveis concretos que o controle oferece para `model`: a escada inteira no
 *  modelo Automático, a do modelo fixo, ou nenhum (sem esforço = sem controle). */
export function effortLevelsFor(model: string | undefined): EffortOption[] {
  return effortLadderFor(model).map((value) => ({ value, label: EFFORT_LABELS[value] ?? value }))
}

/** A lista do seletor de modelo com o Automático só quando o TypeSafe está
 *  pronto ou quando ele é o valor gravado. Sempre na frente. */
export function withAutoModelOption(
  list: readonly { id: string; label: string }[],
  typesafeReady: boolean,
  current: string | undefined
): { id: string; label: string }[] {
  const rest = list.filter((m) => !isAutoModel(m.id))
  return typesafeReady || isAutoModel(current) ? [AUTO_MODEL_OPTION, ...rest] : rest
}

/** O esforço que o decisor escolheu para o turno, quando a escolha gravada é o
 *  Automático e já houve uma decisão; senão `undefined`. */
export function runningEffort(choice: string | undefined, decided: string | undefined): string | undefined {
  return isAutoEffort(choice) && isEffortLevel(decided) ? decided : undefined
}

/**
 * O catálogo de esforço do celular. O cliente (smartfone-remote/www) monta o
 * seletor com `modelEffort[modelo]` e rotula com `effortLabels` — sem a posição
 * `auto` na lista e sem rótulo para ela, uma conversa em Automático aparecia com
 * o seletor em branco. Com `offerAuto`, `auto` entra no começo de cada escada
 * (e o modelo Automático ganha a escada inteira), rotulado "Automático".
 */
export function remoteEffortCatalog(offerAuto: boolean): {
  modelEffort: Record<string, string[]>
  effortLabels: Record<string, string>
} {
  const head = offerAuto ? [AUTO_EFFORT] : []
  const modelEffort: Record<string, string[]> = { [AUTO_MODEL]: [...head, ...effortLadderFor(AUTO_MODEL)] }
  for (const [id, levels] of Object.entries(MODEL_EFFORT)) {
    if (levels.length > 0) modelEffort[id] = [...head, ...levels]
  }
  return { modelEffort, effortLabels: { ...EFFORT_LABELS, [AUTO_EFFORT]: AUTO_EFFORT_LABEL } }
}
