// Passos de tela que a ponte do celular não cobre: reabrir um planejamento existente,
// pedir o handoff ao Agent Manager e enviar para implementação. Seletores mapeados em
// NewPlanningDialog.tsx, HandoffDialog.tsx e HandoffSteps.tsx.
import { pump } from './drive.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Reabre o planejamento `slug` do projeto ativo (cria/abre a conversa do Manager). */
export async function reopenPlan(page, slug) {
  const btn = page.locator('[aria-label="Novo planejamento"]').first()
  await btn.click({ force: true })
  const reopen = page.locator(`button[title="Reabrir o planejamento ${slug}"]`)
  await reopen.waitFor({ state: 'visible', timeout: 30_000 })
  await reopen.click()
  await page.locator('.pl-handoff-btn').first().waitFor({ state: 'visible', timeout: 60_000 })
}

const dialogOf = (page) => page.locator('[role="dialog"][aria-labelledby="pl-handoff-title"]')

/** Abre o diálogo de handoff e pede ao Manager que grave os prompts. */
export async function askManagerForHandoff(page) {
  await page.locator('.pl-handoff-btn').first().click()
  const dialog = dialogOf(page)
  await dialog.waitFor({ state: 'visible' })
  // Ambiguidade aberta bloqueia os botões até confirmar o envio mesmo assim (mesma regra nos dois lados).
  const anyway = dialog.getByLabel(/Enviar mesmo assim/)
  if (await anyway.count()) await anyway.check()
  const ask = dialog.getByRole('button', { name: /^(Pedir ao Agent Manager|Gerar de novo com o Agent Manager)$/ }).first()
  await ask.click()
  return Date.now()
}

/** Insistência ao Manager que terminou o turno sem gravar o handoff (mesma regra nos dois lados). */
export const HANDOFF_NUDGE = 'Siga com o que você recomenda e grave agora o(s) prompt(s) do handoff em _handoff/.'

/** Espera o Manager gravar o(s) prompt(s) e terminar o turno (respondendo permissões no meio). */
export async function waitHandoffWritten(page, bridge, ctx, { managerPick, timeoutMs = 45 * 60_000, log }) {
  const dialog = dialogOf(page)
  const t0 = Date.now()
  let quietSince = null
  let nudges = 0
  while (Date.now() - t0 < timeoutMs) {
    const state = await pump(bridge, ctx, log)
    const manager = managerPick(state)
    const text = (await dialog.textContent().catch(() => '')) ?? ''
    const found = /(\d+) prompts? novos? em _handoff/.exec(text)
    const quiet = manager && !manager.busy && !manager.permission
    quietSince = quiet ? quietSince ?? Date.now() : null
    if (found && quietSince && Date.now() - quietSince > 10_000) return { prompts: Number(found[1]), ms: Date.now() - t0, nudges }
    // Parado há 90 s sem prompt gravado: terminou perguntando ou explicando — insiste.
    if (!found && manager && quietSince && Date.now() - quietSince > 90_000 && nudges < 2) {
      nudges++
      ctx.events.push({ at: Date.now(), conv: manager.id, kind: 'insistencia-handoff' })
      log(`[insistência ${nudges} ao Manager] o handoff não foi gravado`)
      await bridge.send(manager.id, HANDOFF_NUDGE)
      quietSince = null
    }
    await sleep(3000)
  }
  throw new Error('o Agent Manager não gravou o handoff a tempo')
}

/** Revisa e envia para implementação (fast mode desligado). Devolve o texto dos prompts enviados. */
export async function sendToImplementation(page) {
  const dialog = dialogOf(page)
  await dialog.getByRole('button', { name: /^Revisar (prompt|\d+ prompts)$/ }).first().click()
  const boxes = dialog.locator('textarea[aria-label^="Prompt "]')
  await boxes.first().waitFor({ state: 'visible' })
  const prompts = []
  for (let i = 0; i < (await boxes.count()); i++) prompts.push(await boxes.nth(i).inputValue())
  const fast = dialog.getByLabel(/Fast mode/i)
  if ((await fast.count()) && (await fast.isChecked())) await fast.uncheck()
  await dialog.getByRole('button', { name: /^Enviar para implementação$/ }).last().click()
  await dialog.waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => undefined)
  return prompts
}

/** O despachante pode reter o 1º prompt (outro plano com a vez, pasta não limpa): libera. */
export async function releaseHeldHandoff(page) {
  for (const name of ['Começar mesmo assim', 'Enviar agora mesmo assim']) {
    const b = page.getByRole('button', { name }).first()
    if ((await b.count()) && (await b.isVisible().catch(() => false))) {
      await b.click().catch(() => undefined)
      return name
    }
  }
  return null
}
