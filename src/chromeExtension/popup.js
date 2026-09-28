const statusEl = document.getElementById('status')
const label = document.getElementById('label')
const toggle = document.getElementById('toggle')
const versionEl = document.getElementById('version')
let state = null

function render(s) {
  state = s
  statusEl.className = s.paused ? 'paused' : s.connected ? 'on' : ''
  label.textContent = s.paused ? 'Pausado' : s.connected ? 'Conectado ao Agent Code' : 'Não conectado'
  toggle.textContent = s.paused ? 'Retomar' : 'Pausar'
  toggle.disabled = false
  versionEl.textContent = `Versão ${s.version}`
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'getStatus' }).then(render).catch(() => {})
}

toggle.addEventListener('click', () => {
  if (!state) return
  toggle.disabled = true
  chrome.runtime.sendMessage({ type: 'setPaused', paused: !state.paused }).then(render).catch(() => {})
})

refresh()
setInterval(refresh, 2000)
