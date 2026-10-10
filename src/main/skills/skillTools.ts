import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { SKILL_CATEGORIES, type SkillCategory } from '../../shared/ipc'
import type { TieredSkill } from './skillTiers'

/**
 * skills_buscar(texto) e skills_listar(categoria): como o agente acha uma skill
 * de nível baixo, que no catálogo em níveis aparece só pelo nome. Devolvem nome,
 * resumo de uma linha e o caminho do SKILL.md — o agente lê com Read e segue.
 * Só leitura: nenhuma ferramenta daqui grava nada.
 */

export const SKILLS_MCP_SERVER = 'skills'

const fold = (s: string): string => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
const SEARCH_LIMIT = 10

/** A primeira frase da descrição, até 160 caracteres. */
export function skillSummary(description: string): string {
  const first = description.split(/(?<=[.!?])\s/)[0] ?? description
  return first.length > 160 ? `${first.slice(0, 157)}…` : first
}

/**
 * As descrições das skills estão quase todas em inglês e o usuário pede em
 * português: sem isto, "botão não faz nada" não achava nada (visto no app). Cada
 * termo vale pelo próprio texto ou por qualquer tradução da lista.
 */
const PT_EN: Record<string, string[]> = {
  botao: ['button'], tela: ['screen', 'ui'], clique: ['click'], clicar: ['click'], salvar: ['save'], pagina: ['page'],
  teste: ['test', 'testing'], testes: ['test', 'testing'], testar: ['test', 'testing'], componente: ['component'],
  banco: ['database'], dados: ['data'], tabela: ['table'], consulta: ['query'], migracao: ['migration'],
  video: ['video'], lancamento: ['launch'], imagem: ['image'], grafico: ['chart'], apresentacao: ['presentation', 'slides'],
  relatorio: ['report'], documento: ['document'], planilha: ['spreadsheet', 'excel'], contrato: ['contract', 'agreement'],
  seguranca: ['security'], vulnerabilidade: ['vulnerability', 'security'], depurar: ['debug'], depuracao: ['debug'],
  erro: ['error', 'bug'], lento: ['slow', 'performance'], lentidao: ['slow', 'performance'], desempenho: ['performance'],
  formulario: ['form'], implantacao: ['deploy', 'deployment'], acessibilidade: ['accessibility', 'a11y'],
  celular: ['mobile'], navegador: ['browser'], automacao: ['automation'], revisar: ['review'], revisao: ['review'],
  codigo: ['code'], planejar: ['plan', 'planning'], planejamento: ['plan', 'planning'], pagamento: ['payment', 'billing'],
  estoque: ['inventory'], decisao: ['decision'], arquitetura: ['architecture'], conteudo: ['content'], texto: ['writing']
}

export function searchSkills(skills: readonly TieredSkill[], query: string): TieredSkill[] {
  const terms = fold(query).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1)
  if (terms.length === 0) return []
  const groups = terms.map((t) => [t, ...(PT_EN[t] ?? [])])
  const scored = skills
    .map((skill) => {
      const name = fold(skill.name)
      const text = fold(`${skill.description} ${skill.category}`)
      let score = 0
      for (const group of groups) {
        if (group.some((w) => name.includes(w))) score += 3
        else if (group.some((w) => text.includes(w))) score += 1
      }
      return { skill, score }
    })
    .filter((s) => s.score > 0)
  scored.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
  return scored.slice(0, SEARCH_LIMIT).map((s) => s.skill)
}

export type SkillListing =
  | { kind: 'categories'; counts: { category: SkillCategory; count: number }[] }
  | { kind: 'skills'; category: SkillCategory; skills: TieredSkill[] }
  | { kind: 'unknown'; asked: string }

export function listSkillsByCategory(skills: readonly TieredSkill[], category?: string): SkillListing {
  if (!category?.trim()) {
    return {
      kind: 'categories',
      counts: SKILL_CATEGORIES.map((c) => ({ category: c, count: skills.filter((s) => s.category === c).length })).filter((c) => c.count > 0)
    }
  }
  const match = SKILL_CATEGORIES.find((c) => fold(c) === fold(category.trim()))
  if (!match) return { kind: 'unknown', asked: category }
  return {
    kind: 'skills',
    category: match,
    skills: skills.filter((s) => s.category === match).sort((a, b) => a.name.localeCompare(b.name))
  }
}

const line = (s: TieredSkill): string => `- ${s.name} [${s.tier === 'low' ? 'baixa' : s.tier === 'medium' ? 'média' : 'crítica'}] — ${skillSummary(s.description)}\n  SKILL.md: ${s.skillFile}`
type Text = { content: { type: 'text'; text: string }[] }
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] })
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- como o próprio SDK tipa a lista de ferramentas.
type AnyTool = SdkMcpToolDefinition<any>
const erase = (definition: unknown): AnyTool => definition as AnyTool

/** `skills` é lido a cada chamada: a lista acompanha o que está no disco. */
export function createSkillsMcpServer(skills: () => readonly TieredSkill[]): ReturnType<typeof createSdkMcpServer> {
  const tools: AnyTool[] = [
    erase(tool(
      'skills_buscar',
      'Procura skills (inclusive as de nível baixo, que o catálogo mostra só pelo nome) por palavras do pedido. As descrições estão quase todas em inglês: inclua palavras em inglês. Devolve nome, nível, resumo e o caminho do SKILL.md — leia o SKILL.md com Read e siga.',
      { texto: z.string().describe('Palavras do pedido, de preferência também em inglês (ex.: "botão não faz nada button click bug", "react component test", "django").') },
      async (a) => {
        const hits = searchSkills(skills(), a.texto)
        return text(hits.length ? hits.map(line).join('\n') : `Nenhuma skill casa com "${a.texto}". Tente outras palavras ou skills_listar.`)
      }
    )),
    erase(tool(
      'skills_listar',
      `Lista as skills de uma categoria (${SKILL_CATEGORIES.join(', ')}). Sem categoria, mostra as categorias e quantas skills cada uma tem.`,
      { categoria: z.string().optional().describe('Nome da categoria, como na lista.') },
      async (a) => {
        const result = listSkillsByCategory(skills(), a.categoria)
        if (result.kind === 'categories') return text(result.counts.map((c) => `- ${c.category}: ${c.count}`).join('\n'))
        if (result.kind === 'unknown') return text(`Categoria "${result.asked}" não existe. Use uma destas: ${SKILL_CATEGORIES.join(', ')}.`)
        return text(result.skills.length ? result.skills.map(line).join('\n') : `Nenhuma skill em ${result.category}.`)
      }
    ))
  ]
  return createSdkMcpServer({ name: SKILLS_MCP_SERVER, version: '1.0.0', tools })
}
