import { readSecretsForPrompt } from '../memory/memoryRuntime'
import { secretPlaceholder } from '../../shared/contextSnapshot'
import type { SecretValue } from './blocks'

/** O hint das senhas como vai ao modelo e a sua cópia mascarada para a tela. */
export interface SecretsHint {
  /** Texto real, para o system prompt ('' sem senhas). */
  text: string
  /** O mesmo texto com cada valor trocado por `secretPlaceholder(name)`. */
  masked: string
  /** A lista lida do cofre, para mascarar o resto do contexto. */
  secrets: SecretValue[]
}

function render(lines: string): string {
  return `\n\n# Senhas do cofre

O usuário autorizou o acesso a estas credenciais em Configurações. Os valores
abaixo são reais — use-os quando a tarefa precisar e trate-os como segredo:
não os repita na resposta, em log, em commit, nem em arquivo, a menos que o
usuário peça explicitamente.

${lines}`
}

/**
 * Entrega as senhas guardadas ao modelo, em texto puro, quando o usuário liga a
 * opção em Configurações. Desligado (o padrão), devolve texto vazio e nada sai
 * do cofre.
 *
 * O interruptor é lido na montagem da sessão. Ligar depois só vale na sessão
 * seguinte — o system prompt já foi enviado, e não há como retirar da janela do
 * modelo o que já entrou nela.
 */
export async function buildSecretsHintWithMask(): Promise<SecretsHint> {
  // Cofre indisponível degrada o turno; impedir a conversa de abrir seria pior.
  const secrets = await readSecretsForPrompt().catch(() => [] as SecretValue[])
  if (!secrets.length) return { text: '', masked: '', secrets: [] }
  return {
    text: render(secrets.map((secret) => `- ${secret.name}: ${secret.value}`).join('\n')),
    masked: render(secrets.map((secret) => `- ${secret.name}: ${secretPlaceholder(secret.name)}`).join('\n')),
    secrets
  }
}
