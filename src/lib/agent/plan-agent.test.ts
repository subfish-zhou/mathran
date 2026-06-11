import { describe, it, expect, vi } from 'vitest'
import { resolveLink } from './plan-agent'

describe('plan-agent resolveLink', () => {
  it('resolves arxiv ID', async () => {
    // Mock fetch for arXiv API
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: async () => `<?xml version="1.0"?>
<feed><title>ArXiv Query</title>
<entry>
<title>Test Paper Title</title>
<summary>This is an abstract about math.</summary>
<name>Alice</name>
<name>Bob</name>
</entry>
</feed>`,
    }))

    const ref = await resolveLink('https://arxiv.org/abs/2301.12345')
    expect(ref.type).toBe('arxiv')
    expect(ref.resolved).toBe(true)
    expect(ref.title).toBe('Test Paper Title')
    expect(ref.url).toContain('2301.12345')
    vi.unstubAllGlobals()
  })

  it('resolves DOI', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        message: {
          title: ['A Great Paper'],
          author: [{ given: 'John', family: 'Doe' }],
          abstract: 'Abstract text',
        },
      }),
    }))

    const ref = await resolveLink('10.1234/test.5678')
    expect(ref.type).toBe('doi')
    expect(ref.resolved).toBe(true)
    expect(ref.title).toBe('A Great Paper')
    expect(ref.authors).toEqual(['John Doe'])
    vi.unstubAllGlobals()
  })

  it('returns unknown for unrecognized input', async () => {
    const ref = await resolveLink('just some text')
    expect(ref.type).toBe('unknown')
    expect(ref.resolved).toBe(false)
  })

  it('handles fetch failure gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    const ref = await resolveLink('https://arxiv.org/abs/2301.99999')
    expect(ref.type).toBe('arxiv')
    expect(ref.resolved).toBe(false)
    vi.unstubAllGlobals()
  })
})
