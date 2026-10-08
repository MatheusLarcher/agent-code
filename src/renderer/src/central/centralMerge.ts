/**
 * Mescla da Central entre os dois PCs: a regra mora em `@shared/centralMerge`,
 * porque a fila de gravação (main) também mescla — na gravação e no conflito de
 * revisão. Aqui só o atalho com o tipo de conversa da tela.
 */
export { mergeCentralConversation } from '@shared/centralMerge'
