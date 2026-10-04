/**
 * Vocabulário do modelo do escritório (model.ts, turn.ts): o que o personagem
 * está fazendo, o balão sobre ele e onde ele fica. O Escritório 3D lê estes
 * valores do OfficeCharacterModel.
 */

/** Ferramenta em uso: digitando (Edit/Bash…) ou lendo (Read/Grep…). */
export type Activity = 'type' | 'read' | null

export type BubbleKind = 'permissao' | 'pergunta' | 'ok' | 'erro' | 'ampulheta'

/** Papel de um ponto do escritório para onde um personagem pode ser mandado. */
export type DestinationRole =
  | 'porta'
  | 'kanban'
  | 'impressora'
  | 'reuniao'
  | 'reuniao-cabeceira'
  | 'copa'
  | 'arquivo-memorias'
  | 'entrada'
  /** O console da Central, no centro do escritório. */
  | 'central'

export type SeatKind = 'principal' | 'especialista' | 'reuniao'
