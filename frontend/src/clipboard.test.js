import { describe, expect, it, vi } from 'vitest'

import { copyText } from './clipboard.js'

function fakeDoc({ execResult = true } = {}) {
  const removed = []
  const appended = []
  const doc = {
    createElement: () => ({
      style: {},
      setAttribute: () => {},
      select: vi.fn(),
      value: '',
    }),
    body: {
      appendChild: (el) => appended.push(el),
      removeChild: (el) => removed.push(el),
    },
    execCommand: vi.fn(() => execResult),
    _appended: appended,
    _removed: removed,
  }
  return doc
}

describe('copyText', () => {
  it('uses the clipboard API when it succeeds and never touches the fallback', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
    const doc = fakeDoc()
    expect(await copyText('hello', { clipboard, doc })).toBe(true)
    expect(clipboard.writeText).toHaveBeenCalledWith('hello')
    expect(doc.execCommand).not.toHaveBeenCalled()
  })

  it('falls back to execCommand when the clipboard API rejects', async () => {
    // NotAllowedError is what an unfocused document throws — the common case,
    // not an exotic one.
    const clipboard = { writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) }
    const doc = fakeDoc({ execResult: true })
    expect(await copyText('hello', { clipboard, doc })).toBe(true)
    expect(doc.execCommand).toHaveBeenCalledWith('copy')
  })

  it('falls back when the clipboard API is missing entirely', async () => {
    const doc = fakeDoc({ execResult: true })
    expect(await copyText('hello', { clipboard: undefined, doc })).toBe(true)
    expect(doc.execCommand).toHaveBeenCalled()
  })

  it('reports failure when both paths fail, rather than claiming success', async () => {
    const clipboard = { writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) }
    const doc = fakeDoc({ execResult: false })
    expect(await copyText('hello', { clipboard, doc })).toBe(false)
  })

  it('cleans up the temporary textarea even on failure', async () => {
    const doc = fakeDoc({ execResult: false })
    await copyText('hello', { clipboard: undefined, doc })
    expect(doc._appended).toHaveLength(1)
    expect(doc._removed).toHaveLength(1) // no orphan node left in the body
  })

  it('returns false rather than throwing when there is no DOM at all', async () => {
    expect(await copyText('hello', { clipboard: undefined, doc: undefined })).toBe(false)
  })
})
