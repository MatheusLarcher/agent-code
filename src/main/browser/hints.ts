// Instruções fixas do system prompt sobre o navegador do agente, o Android e o
// marcador de download. Curtas de propósito: cada linha é uma regra, e o
// `agentSession.promptBudget.test.ts` segura o tamanho.

export const BROWSER_HINT = `Web browser: the "browser" MCP tools (browser_navigate, _form_fields, _run_steps, _snapshot, _screenshot, _click, _type, _get_text, _evaluate, _back, _reload). Use them to look things up, open sites or interact with pages; pages open in a real Google Chrome window on the user's PC, which the user can watch and use while you work.
- Interacting (forms, clicks, choices): browser_form_fields first, then ONE browser_run_steps with all steps, targeting by label/text; come back only if it stops (continue from the state it returns). Fallback to browser_snapshot/browser_screenshot for canvas pages, empty form_fields or an ambiguous result.
- Tabs are real Chrome tabs named "web - <site>"; exactly one is ACTIVE and every action targets it. browser_list_tabs (all tabs + the active one; the user may open/close tabs too), browser_new_tab, browser_select_tab (by id), browser_close_tab.
- REUSE the current tab (browser_navigate); open a new tab only to keep two pages side by side. Unsure which tab you control? browser_list_tabs or browser_snapshot report it.`

export const ANDROID_HINT = `Android apps ARE supported through the "android" MCP tools (create an app, build an APK, test on Android) — never say it's unsupported.
- Toolchain: android_setup installs JDK + Android SDK + emulator on demand (idempotent, only what's missing; slow the first time). Run it once before building/previewing if missing.
- APK: scaffold (WEB app → wrap with Capacitor and build its android/ folder; native → Kotlin/Gradle), android_build_apk(Gradle root, the folder with gradlew), then android_install_run(.apk) installs and launches it.
- Device: android_open_preview boots a connected phone or the default AVD in its OWN window on the user's PC (the user watches and can touch it; nothing is drawn in this app). You see it only via android_screenshot; act with android_tap/_swipe/_type/_key (normalized 0..1 coordinates matching the screenshot).
- Screen sizes: android_list_device_models, then android_set_device(modelId like "s24", "pixel-8-pro", "tab-s9", or width/height) resizes the emulator. Test a few phone and tablet sizes.`

export const ANDROID_SHORT_HINT = `Android apps, APKs and testing on an Android device ARE supported: call the "app_ativar_android" tool first to turn the Android toolkit on (never say it's unsupported).`

// O renderer troca o marcador por um botão "Baixar" (desktop e app do celular):
// sem ele, um APK gerado não tem como chegar ao telefone.
export const DOWNLOAD_HINT = `To GIVE or SEND the user a file (APK, .zip, PDF, exported document, image, build artifact), don't just print the path: emit a marker on its OWN line, which shows a "Baixar" (download) button on desktop and phone:
[[download:ABSOLUTE_PATH]]   e.g. [[download:C:\\Users\\me\\proj\\android\\app\\build\\outputs\\apk\\debug\\app-debug.apk]]
Absolute path of a finished file that exists; one marker per file; only real deliverables the user asked for (not source you edited). After building e.g. an APK, locate it and emit its marker.`
