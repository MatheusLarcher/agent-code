/**
 * Falas dos agentes do Escritório 3D — API pública do módulo quips/.
 *
 * Duas peças independentes, ligadas pelo engine (etapa 3):
 *   generator.ts   createQuipEngine(rng).step(statuses, events, now) → Map<key, Quip | null>
 *                  Puro: decide o balão de cada agente (prioridade, TTL,
 *                  cooldown, variação pelo rng). Detalhes no topo do arquivo.
 *   bubbleLayer.ts createBubbleLayer(container, { onClick }) → { set, size, place, compact, dispose }
 *                  DOM puro e barato: um elemento por balão (pool), posição só
 *                  por transform; o tamanho é medido no set, nunca por quadro.
 *                  Estilos em quips.css (importado por ele).
 * Apoio: lines.ts (as falas, por situação), format.ts (preencher e cortar ≤ 72)
 * e powerVoice.ts (quem fala da energia do escritório e da festa do apagão;
 * entra pelo 4º argumento do step: createQuipEngine(rng).step(…, now, power)).
 *
 * Ligação no motor: ../speech.ts (seleção, LOD, escala e posição por quadro;
 * a des-sobreposição em tela é ../bubbleLayout.ts). Esquema:
 *   const quips = createQuipEngine(seededRng(Date.now()))
 *   const layer = createBubbleLayer(stageEl, { onClick: (key) => focusCharacter(key) })
 *   // A cada tique — feed novo ou ~4×/s sem feed (TTL e ociosos dependem disso).
 *   // `now` em epoch ms, o MESMO passado ao snapshotOf.
 *   const snap = snapshotOf(feed, model, now)
 *   const events = diffEvents(prevSnap, snap, now)
 *   for (const [key, quip] of quips.step(snap.agents, events, now)) {
 *     if (layer.set(key, quip)) requestRender() // balão novo precisa de um place
 *   }
 *   // A cada quadro, para quem tem balão: ponto logo acima da cabeça, em px do
 *   // stageEl (`stack` opcional: compacto, andares subidos e fim da linha-guia).
 *   layer.place(key, x, y, scale, visible, stack)
 *   // Ao desmontar:
 *   layer.dispose()
 */
export {
  createQuipEngine,
  seededRng,
  PRIORITY,
  TTL_MS,
  MIN_DWELL_MS,
  REPEAT_MS,
  IDLE_MIN_MS,
  IDLE_MAX_MS,
  IDLE_CHANCE,
  type Quip,
  type QuipKind,
  type QuipEngine,
  type Rng
} from './generator'
export {
  createBubbleLayer,
  EXIT_MS,
  SCALE_MIN,
  SCALE_MAX,
  FONT_PX,
  COMPACT_W,
  COMPACT_H,
  type BubbleLayer,
  type BubbleLayerOptions,
  type BubbleSize,
  type BubbleStack
} from './bubbleLayer'
export { QUIP_MAX } from './format'
export { PARTY_TALKERS, type PowerQuipInput } from './powerVoice'
