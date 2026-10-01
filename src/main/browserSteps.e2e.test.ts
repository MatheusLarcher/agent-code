// @vitest-environment node
// browser_form_fields + browser_run_steps against a local fixture in the real
// Playwright Chromium. Skipped when Chromium is missing.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import { collectFields, formatFields } from './browserFields'
import { runSteps } from './browserSteps'
import { BrowserController } from './browserController'

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
})()

// Grid labels (no `for`), custom radios hidden by CSS, native select, a
// dependent field (Cidade appears after Estado), checkbox and a JS submit.
const FORM = `<!doctype html><html><head><title>Cadastro</title><style>
.grid { display: flex; gap: 8px } .hid { display: none } .opt label { padding: 4px; border: 1px solid #999 }
</style></head><body><main>
<form id="f">
  <div class="grid"><div class="col"><label>Nome completo</label></div><div class="col"><input name="nome" required></div></div>
  <div class="grid"><div class="col"><label>E-mail</label></div><div class="col"><input type="email" name="email"></div></div>
  <div class="grid"><div class="col"><label>Senha</label></div><div class="col"><input type="password" name="senha"></div></div>
  <div class="opt">
    <input class="hid" type="radio" name="gender" id="g1" value="M"><label for="g1">Male</label>
    <input class="hid" type="radio" name="gender" id="g2" value="F"><label for="g2">Female</label>
    <input class="hid" type="radio" name="gender" id="g3" value="O"><label for="g3">Other</label>
  </div>
  <label for="estado">Estado</label>
  <select id="estado"><option value="">Selecione</option><option value="SP">São Paulo</option><option value="RJ">Rio de Janeiro</option></select>
  <div id="cidadeBox"></div>
  <input type="checkbox" id="termos"><label for="termos">Aceito os termos</label>
  <button type="submit">Enviar</button>
</form>
<p id="msg"></p>
</main>
<script>
document.getElementById('estado').addEventListener('change', () => {
  setTimeout(() => {
    document.getElementById('cidadeBox').innerHTML = '<label for="cidade">Cidade</label><input id="cidade">'
  }, 400)
})
document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault()
  document.getElementById('msg').textContent = 'Obrigado pelo envio!'
})
</script></body></html>`

describe.skipIf(!hasChromium)('browser_form_fields + browser_run_steps (Chromium real)', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
  }, 60_000)
  afterAll(async () => {
    await browser?.close()
  })
  beforeEach(async () => {
    await page?.close()
    page = await browser.newPage()
    await page.setContent(FORM)
  }, 30_000)

  it('lê os campos com rótulo em grade, rádio escondido por CSS e refs estáveis', async () => {
    const snap = await collectFields(page)
    const text = formatFields(snap)
    expect(text).toContain('text* "Nome completo"')
    expect(text).toContain('email "E-mail"')
    expect(text).toContain('select-one "Estado" [Selecione | São Paulo | Rio de Janeiro]')
    expect(text).toContain('checkbox "Aceito os termos" = off')
    expect(text).toMatch(/submit "Enviar"$/m)
    expect(text).toMatch(/url: .* \| title: Cadastro$/)
    // Risk from the prototype: a radio group with no label of its own took the
    // label of the previous field. The options must still come out right.
    const radio = snap.fields.find((f) => f.type === 'radio')!
    expect(radio.label).toBe('gender')
    expect(radio.options).toEqual([
      { label: 'Male', ref: expect.stringMatching(/^e\d+$/) },
      { label: 'Female', ref: expect.stringMatching(/^e\d+$/) },
      { label: 'Other', ref: expect.stringMatching(/^e\d+$/) }
    ])

    // Same refs on a second read; a new control continues the numbering.
    const max = Math.max(...snap.fields.map((f) => Number(f.ref.slice(1))), 0)
    await page.evaluate(() => document.getElementById('cidadeBox')!.insertAdjacentHTML('beforeend', '<label for="x">Extra</label><input id="x">'))
    const again = await collectFields(page)
    const refs = new Map(again.fields.map((f) => [`${f.type} ${f.label}`, f.ref]))
    for (const f of snap.fields) expect(refs.get(`${f.type} ${f.label}`)).toBe(f.ref)
    expect(refs.get('text Extra')).toBe(`e${max + 1}`)
  }, 30_000)

  it('preenche tudo numa chamada, alvos por rótulo, e confirma pelo expect', async () => {
    const r = await runSteps(
      page,
      [
        { action: 'fill', target: { label: 'nome completo' }, value: 'Maria Souza' },
        { action: 'fill', target: { label: 'E-mail' }, value: 'maria@example.com' },
        { action: 'fill', target: { label: 'Senha' }, value: 'segredo123' },
        { action: 'check', target: { label: 'female' } },
        { action: 'select', target: { label: 'estado' }, value: 'Sao Paulo' },
        { action: 'fill', target: { label: 'Cidade' }, value: 'Campinas' },
        { action: 'check', target: { label: 'Aceito os termos' } },
        { action: 'click', target: { text: 'Enviar' } }
      ],
      'Obrigado pelo envio'
    )
    expect(r).toMatchObject({ ok: true, done: 8, total: 8, outcome: 'expect', message: 'Obrigado pelo envio!' })
    expect(r.failedStep).toBeUndefined()
    const values = await page.evaluate(() => ({
      nome: (document.querySelector('[name=nome]') as HTMLInputElement).value,
      gender: (document.querySelector('[name=gender]:checked') as HTMLInputElement | null)?.value,
      estado: (document.getElementById('estado') as HTMLSelectElement).value,
      cidade: (document.getElementById('cidade') as HTMLInputElement).value,
      termos: (document.getElementById('termos') as HTMLInputElement).checked
    }))
    expect(values).toEqual({ nome: 'Maria Souza', gender: 'F', estado: 'SP', cidade: 'Campinas', termos: true })
    // The password never shows up in the result.
    expect(r.state).toContain('password "Senha" = "••••"')
    expect(JSON.stringify(r)).not.toContain('segredo123')
    expect(r.state).toContain('radio "gender" [Male=')
  }, 60_000)

  it('grupo de rádio pelo rótulo do grupo + value', async () => {
    const r = await runSteps(page, [{ action: 'select', target: { label: 'gender' }, value: 'other' }])
    expect(r.ok).toBe(true)
    expect(await page.evaluate(() => (document.querySelector('[name=gender]:checked') as HTMLInputElement).value)).toBe('O')
  }, 30_000)

  it('campo obrigatório vazio: outcome invalid, ok=false, lista o campo', async () => {
    const r = await runSteps(
      page,
      [
        { action: 'fill', target: { label: 'E-mail' }, value: 'a@b.com' },
        { action: 'click', target: { text: 'Enviar' } }
      ],
      'Obrigado pelo envio'
    )
    expect(r.ok).toBe(false)
    expect(r.outcome).toBe('invalid')
    expect(r.invalid?.[0]).toMatch(/^e\d+ "Nome completo"$/)
    expect(await page.textContent('#msg')).toBe('')
  }, 30_000)

  it('alvo inexistente com timeout curto: para no passo certo e devolve o state', async () => {
    const t0 = Date.now()
    const r = await runSteps(page, [
      { action: 'fill', target: { label: 'Nome completo' }, value: 'Ana' },
      { action: 'fill', target: { label: 'Telefone' }, value: '11999998888', timeoutMs: 300 },
      { action: 'click', target: { text: 'Enviar' } }
    ])
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(r.ok).toBe(false)
    expect(r.done).toBe(1)
    expect(r.failedStep).toMatchObject({ i: 1, action: 'fill', target: { label: 'Telefone' }, error: 'alvo não encontrado' })
    expect(r.state).toContain('"Nome completo" = "Ana"')
    expect(r.state).toMatch(/url: .* \| title: Cadastro/)
  }, 30_000)

  it('combobox customizado (estilo react-select): digita, Enter e confere o valor mostrado', async () => {
    await page.setContent(`<title>Combo</title>
      <label>Matéria</label>
      <div class="subj-container"><div class="subj-value"><div class="subj-placeholder">Escolha</div>
        <input id="c" role="combobox"></div><div class="subj-indicatorContainer">v</div></div>
      <div id="menu"></div>
      <script>
        const c = document.getElementById('c'), menu = document.getElementById('menu')
        c.addEventListener('input', () => {
          menu.innerHTML = ['Matemática', 'Física'].filter((o) => o.toLowerCase().startsWith(c.value.toLowerCase()))
            .map((o) => '<div class="subj-option">' + o + '</div>').join('')
        })
        c.addEventListener('keydown', (e) => {
          const first = menu.querySelector('.subj-option')
          if (e.key !== 'Enter' || !first) return
          const box = c.parentElement
          box.querySelector('.subj-placeholder')?.remove()
          box.insertAdjacentHTML('afterbegin', '<div class="subj-singleValue">' + first.textContent + '</div>')
          c.value = ''; menu.innerHTML = ''
        })
      </script>`)
    const before = formatFields(await collectFields(page))
    expect(before).toContain('combobox "Matéria (Escolha)"')
    const r = await runSteps(page, [{ action: 'select', target: { label: 'materia' }, value: 'Mate' }])
    expect(r).toMatchObject({ ok: true, done: 1 })
    expect(r.state).toContain('combobox "Matéria" = "Matemática')
    const bad = await runSteps(page, [{ action: 'select', target: { label: 'materia' }, value: 'Química' }])
    expect(bad.failedStep?.error).toBe('a lista não aceitou "Química"')
  }, 30_000)

  it('react-select múltiplo (chips multiValue) e simples com rótulo só de placeholder', async () => {
    // Same nesting as react-select: input-container inside value-container
    // inside the outer container that holds the indicator.
    await page.setContent(`<title>Multi</title><form>
      <label>Matérias</label>
      <div class="rs-container"><div class="rs__control"><div class="rs__value-container">
        <div class="rs__input-container"><input id="mi" role="combobox"></div></div>
        <div class="css-a-indicatorContainer">v</div></div><div class="menu"></div></div>
      <div class="city-container"><div class="city__value-container"><div class="city__placeholder">Select City</div>
        <div class="city__input-container"><input id="ci"></div></div>
        <div class="css-b-indicatorContainer">v</div><div class="menu"></div></div>
      </form>
      <script>
        // Like react-select's default filter: case- and accent-insensitive.
        const key = (s) => s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase()
        function wire(input, list, multi) {
          const box = input.closest('.rs-container, .city-container'), menu = box.querySelector('.menu')
          input.addEventListener('input', () => {
            menu.innerHTML = list.filter((o) => key(o).startsWith(key(input.value)))
              .map((o) => '<div class="css-o-option">' + o + '</div>').join('')
          })
          input.addEventListener('keydown', (e) => {
            const first = menu.querySelector('.css-o-option')
            if (e.key !== 'Enter' || !first) return
            e.preventDefault()
            const v = first.textContent, ic = input.parentElement
            if (multi) {
              ic.insertAdjacentHTML('beforebegin', '<div class="css-c-multiValue"><div class="rs__multi-value__label">' + v +
                '</div><div role="button" aria-label="Remove ' + v + '" class="rs__multi-value__remove">x</div></div>')
            } else {
              box.querySelector('.city__placeholder')?.remove()
              box.querySelector('.city__single-value')?.remove()
              ic.insertAdjacentHTML('beforebegin', '<div class="city__single-value">' + v + '</div>')
            }
            input.value = ''; menu.innerHTML = ''
          })
        }
        wire(document.getElementById('mi'), ['Matemática', 'Física', 'Química'], true)
        wire(document.getElementById('ci'), ['Delhi', 'Agra'], false)
      </script>`)
    const before = formatFields(await collectFields(page))
    expect(before).toContain('combobox "Matérias"')
    expect(before).toContain('combobox "Select City"')
    const r = await runSteps(page, [
      { action: 'select', target: { label: 'materias' }, value: ['mate', 'fis'] },
      { action: 'select', target: { label: 'Select City' }, value: 'Delhi' }
    ])
    expect(r.failedStep).toBeUndefined()
    expect(r).toMatchObject({ ok: true, done: 2 })
    expect(r.state).toContain('combobox "Matérias" = ["Matemática","Física"]')
    // The placeholder is gone after the pick; the label stays the same.
    expect(r.state).toContain('combobox "Select City" = "Delhi"')
    // Chip "Remove X" buttons are not listed nor targetable by {text}.
    expect(r.state).not.toContain('Remove')
    const rm = await runSteps(page, [{ action: 'click', target: { text: 'Remove Física' }, timeoutMs: 300 }])
    expect(rm.failedStep?.error).toBe('alvo não encontrado')
  }, 30_000)

  it('alvo ambíguo para na hora com os candidatos', async () => {
    await page.evaluate(() =>
      document.getElementById('cidadeBox')!.insertAdjacentHTML(
        'beforeend',
        '<label for="a1">Endereço de cobrança</label><input id="a1"><label for="a2">Endereço de entrega</label><input id="a2">'
      )
    )
    const r = await runSteps(page, [{ action: 'fill', target: { label: 'endereco' }, value: 'Rua A' }])
    expect(r.ok).toBe(false)
    expect(r.failedStep?.error).toBe('alvo ambíguo')
    expect(r.failedStep?.candidates?.map((c) => c.label)).toEqual(['Endereço de cobrança', 'Endereço de entrega'])
  }, 30_000)
}, 120_000)

describe.skipIf(!hasChromium)('BrowserController repassa form_fields/run_steps para a aba ativa', () => {
  const ctrl = new BrowserController({ onFrame: () => {}, onState: () => {}, onPicked: () => {} }, 'form-steps-e2e')
  afterAll(async () => {
    await ctrl.close()
  })

  it('lê e preenche pela aba ativa', async () => {
    await ctrl.navigate('data:text/html,' + encodeURIComponent(FORM))
    expect(await ctrl.formFields()).toContain('text* "Nome completo"')
    const r = await ctrl.runSteps(
      [
        { action: 'fill', target: { label: 'Nome completo' }, value: 'Ana' },
        { action: 'click', target: { text: 'Enviar' } }
      ],
      'Obrigado pelo envio'
    )
    expect(r).toMatchObject({ ok: true, outcome: 'expect' })
  }, 60_000)
})
