// On-device dictation: Parakeet TDT 0.6B v3 via the local "ParakeetStt" Capacitor
// plugin (smartfone-remote/plugins/parakeet-stt). The model (~490 MB) is not in
// the APK: it is installed from the "Voz" card in Settings, or automatically on
// the first recording (that first audio still goes to the PC meanwhile).
// Any local failure falls back to the PC's /api/transcribe, as before.
//
// No bundler here: talks to the plugin through the Capacitor native bridge
// (Capacitor.nativePromise / Capacitor.addListener) and exposes window.LocalStt.
;(function () {
  'use strict'

  var PLUGIN = 'ParakeetStt'
  var PREF_PC = 'agentRemote.voice.usePc'
  var TARGET_RATE = 16000

  var st = { installed: false, installing: false, progress: 0, device: 'cpu', soc: '', bytes: 0, error: '' }
  var autoTried = false // one automatic install attempt per app session; retries are manual (card)
  var listeners = []

  function cap() { return window.Capacitor }

  /** True inside the installed app with the plugin compiled in. */
  function available() {
    var C = cap()
    if (!C || typeof C.nativePromise !== 'function') return false
    var heads = C.PluginHeaders || []
    for (var i = 0; i < heads.length; i++) if (heads[i] && heads[i].name === PLUGIN) return true
    return false
  }

  function call(method, opts) { return cap().nativePromise(PLUGIN, method, opts || {}) }

  function usePc() { return localStorage.getItem(PREF_PC) === '1' }
  function setUsePc(on) { localStorage.setItem(PREF_PC, on ? '1' : '0'); changed() }

  /** Local transcription will be attempted for the next recording. */
  function ready() { return available() && !usePc() && st.installed }

  function onChange(fn) { listeners.push(fn) }
  function changed() { for (var i = 0; i < listeners.length; i++) { try { listeners[i](st) } catch (e) {} } }

  function refresh() {
    if (!available()) return Promise.resolve(st)
    return call('status').then(function (s) {
      st.installed = !!s.installed
      st.installing = !!s.installing
      st.progress = s.progress || 0
      st.device = s.device || 'cpu'
      st.soc = s.soc || ''
      st.bytes = s.bytes || 0
      changed()
      return st
    }, function () { return st })
  }

  var progressSub = null
  function install() {
    if (!available()) return Promise.reject(new Error('Indisponível neste app.'))
    if (st.installing) return Promise.resolve(false)
    st.installing = true
    st.progress = 0
    st.error = ''
    changed()
    if (!progressSub) {
      progressSub = cap().addListener(PLUGIN, 'progress', function (ev) {
        st.progress = (ev && ev.percent) || 0
        changed()
      })
    }
    return call('install').then(function () {
      st.installing = false
      st.error = ''
      return refresh().then(function () { return true })
    }, function (e) {
      st.installing = false
      st.error = (e && e.message) || 'falha'
      changed()
      throw e
    })
  }

  function cancel() { return available() ? call('cancel') : Promise.resolve() }
  function remove() { return call('remove').then(refresh) }

  // ---- audio: MediaRecorder blob → 16 kHz mono Float32 → base64 --------------

  function toPcm16k(blob) {
    return blob.arrayBuffer().then(function (buf) {
      var AC = window.AudioContext || window.webkitAudioContext
      var ctx = new AC()
      return new Promise(function (resolve, reject) {
        ctx.decodeAudioData(buf, resolve, reject)
      }).then(function (decoded) {
        try { ctx.close() } catch (e) {}
        var frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE))
        // OfflineAudioContext with 1 channel downmixes and resamples in one pass.
        var off = new OfflineAudioContext(1, frames, TARGET_RATE)
        var src = off.createBufferSource()
        src.buffer = decoded
        src.connect(off.destination)
        src.start(0)
        return off.startRendering()
      }, function (e) {
        try { ctx.close() } catch (x) {}
        throw new Error('Não consegui decodificar o áudio (' + ((e && e.message) || 'formato') + ').')
      })
    }).then(function (rendered) { return rendered.getChannelData(0) })
  }

  function floatsToBase64(f32) {
    var bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength) // little-endian on Android
    var s = ''
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    return btoa(s)
  }

  function transcribeLocal(blob) {
    return toPcm16k(blob).then(function (pcm) {
      return call('transcribe', { pcm: floatsToBase64(pcm) })
    }).then(function (r) { return String((r && r.text) || '').trim() })
  }

  /**
   * Route one recording. ctx = { pcReady, toPc(), insert(text), done(), fail(msg) }.
   * Local first when installed; otherwise the PC (and, the first time, start the
   * model install in the background).
   */
  function handle(blob, ctx) {
    if (!available() || usePc()) return ctx.toPc()
    if (st.installed) {
      return transcribeLocal(blob).then(function (text) {
        if (text) ctx.insert(text)
        ctx.done()
      }, function (e) {
        var why = (e && e.message) || 'erro'
        if (ctx.pcReady) ctx.toPc()
        else ctx.fail('Transcrição no celular falhou: ' + why)
      })
    }
    if (!st.installing && !autoTried) {
      autoTried = true
      install().catch(function () { /* shown in the Voz card; PC keeps working */ })
    }
    if (ctx.pcReady) return ctx.toPc()
    ctx.fail(st.installing
      ? 'Instalando a voz no celular (' + st.progress + '%). Tente de novo quando terminar.'
      : 'Voz indisponível: instale o modelo em Configurações → Voz.')
  }

  // ---- "Voz" card in Settings -----------------------------------------------

  function mb(n) { return Math.round(n / (1024 * 1024)) + ' MB' }

  function renderCard() {
    var card = document.getElementById('cfg-voice')
    if (!card) return
    var ok = available()
    card.hidden = !ok
    if (!ok) return
    var status = document.getElementById('voice-status')
    var bar = document.getElementById('voice-progress')
    var fill = document.getElementById('voice-progress-fill')
    var btnInstall = document.getElementById('voice-install')
    var btnCancel = document.getElementById('voice-cancel')
    var btnRemove = document.getElementById('voice-remove')
    var dev = document.getElementById('voice-device')
    var pc = document.getElementById('voice-use-pc')

    if (st.installing) status.textContent = 'Baixando e instalando… ' + st.progress + '%'
    else if (st.installed) status.textContent = 'Instalado (' + mb(st.bytes) + ')'
    else status.textContent = st.error ? 'Falhou: ' + st.error : 'Não instalado (download de ~490 MB)'
    bar.hidden = !st.installing
    fill.style.width = st.progress + '%'
    btnInstall.hidden = st.installed || st.installing
    btnInstall.textContent = st.error ? 'Tentar de novo' : 'Instalar modelo'
    btnCancel.hidden = !st.installing
    btnRemove.hidden = !st.installed || st.installing
    dev.textContent = usePc() ? 'PC' : (st.installed ? 'Celular · CPU' : 'PC (até instalar)')
    var soc = document.getElementById('voice-soc')
    if (soc) soc.textContent = st.soc || '—'
    pc.checked = usePc()
  }

  function wireCard() {
    var card = document.getElementById('cfg-voice')
    if (!card) return
    document.getElementById('voice-install').addEventListener('click', function () {
      install().catch(function () {})
    })
    document.getElementById('voice-cancel').addEventListener('click', function () { cancel() })
    document.getElementById('voice-remove').addEventListener('click', function () {
      if (confirm('Remover o modelo de voz do celular? A transcrição volta a ser feita no PC.')) remove()
    })
    document.getElementById('voice-use-pc').addEventListener('change', function (e) { setUsePc(e.target.checked) })
    onChange(renderCard)
  }

  window.LocalStt = {
    available: available,
    ready: ready,
    refresh: refresh,
    install: install,
    handle: handle,
    onChange: onChange,
    renderCard: renderCard,
    state: st
  }

  function boot() { wireCard(); if (available()) refresh() }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
