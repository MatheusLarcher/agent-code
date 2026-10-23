/**
 * Regras do app que valem para todos os usuários (resources/agent.md, embutido no
 * bundle pelo Vite): entram no system prompt de toda conversa, inclusive a do
 * planejamento. Regra nova para todo mundo vai no .md, não num hint solto.
 */
import agentRulesText from '../../../resources/agent.md?raw'

export const AGENT_RULES_HINT = agentRulesText.trim()
