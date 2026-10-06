/**
 * Onde o app está rodando. O APK é um WebView do Android, e o Android injeta a ponte nativa
 * do Capacitor em `window.Capacitor` (ver env.d.ts); no navegador (`/app/?token=…`, servido
 * pela ponte do PC) ela não existe. Daí que a lista de filiais e o "Abrir filial" valem só no
 * APK: o navegador tem um PC só (o próprio endereço da página) e a câmera do leitor de QR
 * exige contexto seguro, que `http://ip:porta` não é.
 */
export function isApk(): boolean {
  return typeof window !== 'undefined' && !!window.Capacitor
}
