// API pública do gerador de planta. O painel importa daqui, não dos arquivos internos.

export { buildBuilding, type BuildingInput, type BuildingRoomInput } from './building'
export { EMPTY_SLOT, stableRoomOrder } from './roomOrder'
export { BASE_PRINCIPALS, DESKS_PER_ROW, ROOM_W, SPECIALIST_SLOTS } from './roomTemplate'
