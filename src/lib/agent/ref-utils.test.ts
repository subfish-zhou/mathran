import { describe, it, expect } from 'vitest'
import { extractWorkspaceRefs, collectWikiWorkspaceRefStats, repairWorkspaceRefs } from './ref-utils'

describe('extractWorkspaceRefs', () => {
  it('extracts refs from content', () => {
    const refs = extractWorkspaceRefs('See @ws:effort-123 and @ws:effort-456')
    expect(refs).toEqual(['effort-123', 'effort-456'])
  })

  it('deduplicates by default', () => {
    const refs = extractWorkspaceRefs('@ws:abc @ws:abc')
    expect(refs).toEqual(['abc'])
  })

  it('returns duplicates when dedupe=false', () => {
    const refs = extractWorkspaceRefs('@ws:abc @ws:abc', { dedupe: false })
    expect(refs).toEqual(['abc', 'abc'])
  })

  it('returns empty for no refs', () => {
    expect(extractWorkspaceRefs('no refs here')).toEqual([])
  })
})

describe('collectWikiWorkspaceRefStats', () => {
  it('counts valid and broken refs', () => {
    const pages = [{ content: '@ws:e1 @ws:e2 @ws:missing' }]
    const efforts = [
      { id: 'e1', type: 'PROOF' },
      { id: 'e2', type: 'CONJECTURE' },
    ]
    const stats = collectWikiWorkspaceRefStats(pages, efforts as any)
    expect(stats.validRefs).toBe(2)
    expect(stats.brokenRefs).toBe(1)
  })

  it('counts uncovered non-REFERENCE items', () => {
    const pages = [{ content: '@ws:e1' }]
    const efforts = [
      { id: 'e1', type: 'PROOF' },
      { id: 'e2', type: 'CONJECTURE' },
      { id: 'e3', type: 'REFERENCE' },
    ]
    const stats = collectWikiWorkspaceRefStats(pages, efforts as any)
    expect(stats.uncoveredItems).toBe(1) // e2 is uncovered, e3 is REFERENCE so excluded
  })
})

describe('repairWorkspaceRefs', () => {
  const efforts = [
    {
      id: 'tao-2017-logarithmic-improvement',
      type: 'PROOF_ATTEMPT',
      title: 'Tao (2017): logarithmic improvement to the general lower bound',
    },
    {
      id: 'rosenfeld-2025-nine-runners',
      type: 'PROOF_ATTEMPT',
      title: 'Rosenfeld (2025): the Lonely Runner Conjecture for nine runners',
    },
  ]

  it('maps citation-style aliases to effort ids', () => {
    const repaired = repairWorkspaceRefs('See [@ws:Tao2017] and @ws:Rosenfeld2025Nine.', efforts as any)

    expect(repaired.content).toContain('@ws:tao-2017-logarithmic-improvement')
    expect(repaired.content).toContain('@ws:rosenfeld-2025-nine-runners')
    expect(repaired.fixedRefs).toBe(2)
    expect(repaired.removedRefs).toBe(0)
  })

  it('repairs markdown workspace links', () => {
    const repaired = repairWorkspaceRefs('[Tao](@ws:Tao2017#idea)', efforts as any)

    expect(repaired.content).toBe('[Tao](@ws:tao-2017-logarithmic-improvement#idea)')
    expect(repaired.fixedRefs).toBe(1)
  })

  it('strips unresolved workspace prefixes instead of leaving broken links', () => {
    const repaired = repairWorkspaceRefs('See [Bad](@ws:Missing2020) and [@ws:UnknownKey].', efforts as any)

    expect(repaired.content).toBe('See Bad and [UnknownKey].')
    expect(repaired.removedRefs).toBe(2)
    expect(repaired.unresolvedRefs).toEqual(['Missing2020', 'UnknownKey'])
  })
})
