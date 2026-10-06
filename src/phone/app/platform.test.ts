import { afterEach, describe, expect, it } from 'vitest'
import { isApk } from './platform'

describe('isApk', () => {
  afterEach(() => {
    delete window.Capacitor
  })

  it('no navegador (sem a ponte nativa do Capacitor) não é o APK', () => {
    expect(isApk()).toBe(false)
  })

  it('com window.Capacitor (injetado pelo Android no WebView) é o APK', () => {
    window.Capacitor = {}
    expect(isApk()).toBe(true)
  })
})
