/**
 * "O usuário está olhando a sala de reunião?" — quem sabe é o motor (a zona da
 * TV à vista, motor rodando); quem pergunta é o aviso do chamado (sem
 * notificação nesse caso). O Office3DWorkspace liga a sonda ao montar e
 * desliga ao desmontar; sem escritório, a resposta é não.
 */
let probe: (() => boolean) | null = null

export function setMeetingProbe(fn: (() => boolean) | null): void {
  probe = fn
}

export function meetingInView(): boolean {
  try {
    return probe?.() ?? false
  } catch {
    return false
  }
}
