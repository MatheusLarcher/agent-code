import { beforeEach, describe, expect, it } from 'vitest'
import { CHAT_DEFAULT_W, CHAT_MIN_W, maxChatWidth, MONITOR_APPS, monitorPrefs } from './monitorPrefs'

beforeEach(() => localStorage.clear())

describe('monitorPrefs', () => {
  it('dois apps (o Chat mora no Código); o "chat" gravado antes abre no Código; lixo vale nada', () => {
    expect(MONITOR_APPS).toEqual(['code', 'ctx'])
    expect(monitorPrefs.app()).toBeNull()
    localStorage.setItem('agentcode.monitor.app', 'chat')
    expect(monitorPrefs.app()).toBe('code')
    monitorPrefs.setApp('ctx')
    expect(monitorPrefs.app()).toBe('ctx')
    localStorage.setItem('agentcode.monitor.app', 'preview')
    expect(monitorPrefs.app()).toBeNull()
  })

  it('largura do Chat: padrão 400; a escolhida volta (px inteiros, nunca abaixo de 280); lixo vale o padrão', () => {
    expect(monitorPrefs.chatWidth()).toBe(CHAT_DEFAULT_W)
    expect(CHAT_DEFAULT_W).toBe(400)
    monitorPrefs.setChatWidth(512.6)
    expect(localStorage.getItem('agentcode.monitor.chatWidth')).toBe('513')
    expect(monitorPrefs.chatWidth()).toBe(513)
    localStorage.setItem('agentcode.monitor.chatWidth', '120')
    expect(monitorPrefs.chatWidth()).toBe(CHAT_MIN_W)
    localStorage.setItem('agentcode.monitor.chatWidth', 'lixo')
    expect(monitorPrefs.chatWidth()).toBe(CHAT_DEFAULT_W)
    monitorPrefs.setChatWidth(Number.NaN)
    expect(localStorage.getItem('agentcode.monitor.chatWidth')).toBe('lixo')
  })

  it('o teto do Chat: 60% da tela, sem deixar o editor com menos de 320 px; tela pequena vale o mínimo; tela não medida, sem teto', () => {
    // 1920 px com 271 px fixos (atividades 46 + explorador 224 + borda 1): 60% = 1152 vence (o editor ainda tem 497).
    expect(maxChatWidth(1920, 271)).toBe(1152)
    // 1280 px com os mesmos 271 px: 1280 − 271 − 320 = 689 vence os 768 de 60%.
    expect(maxChatWidth(1280, 271)).toBe(689)
    // Tela pequena: o teto cairia abaixo do mínimo — vale o mínimo.
    expect(maxChatWidth(800, 211)).toBe(CHAT_MIN_W)
    expect(maxChatWidth(0, 271)).toBe(Infinity)
  })
})
