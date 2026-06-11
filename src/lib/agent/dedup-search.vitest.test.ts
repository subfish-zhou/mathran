import { describe, it, expect } from 'vitest'
import { searchSimilarProjectsInCorpus } from './dedup-search'

const corpus = [
  {
    id: 'p1', title: 'Bounded Gaps Between Primes', slug: 'twin-prime',
    description: 'Maynard-Tao sieve method for prime gap bounds.',
    formalStatement: 'liminf (p_{n+1}-p_n) <= 246', status: 'ACTIVE', memberCount: 10,
  },
  {
    id: 'p2', title: 'Collatz Conjecture', slug: 'collatz',
    description: 'Iterative 3n+1 dynamics and stopping time analysis.',
    formalStatement: 'Every positive integer reaches 1.', status: 'ACTIVE', memberCount: 8,
  },
  {
    id: 'p3', title: "Goldbach's Conjecture", slug: 'goldbach',
    description: 'Every even integer > 2 is sum of two primes.',
    formalStatement: '2n = p + q', status: 'ACTIVE', memberCount: 7,
  },
  {
    id: 'p4', title: 'Furstenberg Set Conjecture in the Plane', slug: 'furstenberg',
    description: 'Hausdorff dimension bounds for Furstenberg sets.',
    formalStatement: 'dim_H(E) >= min(s+t, (3s+t)/2, s+1)', status: 'ACTIVE', memberCount: 5,
  },
] as const

describe('searchSimilarProjectsInCorpus', () => {
  it('returns only strongly related projects for specific query', () => {
    const results = searchSimilarProjectsInCorpus('furstenberg set conjecture', corpus, 5)
    expect(results).toHaveLength(1)
    expect(results[0]?.slug).toBe('furstenberg')
  })

  it('filters unrelated generic-word matches', () => {
    const results = searchSimilarProjectsInCorpus('graph coloring problem', corpus, 5)
    expect(results).toEqual([])
  })

  it('keeps precise top match for prime-gap queries', () => {
    const results = searchSimilarProjectsInCorpus('prime gaps maynard tao sieve', corpus, 5)
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0]?.slug).toBe('twin-prime')
    expect(results.some(r => r.slug === 'collatz')).toBe(false)
  })

  it('collatz query should not drag in unrelated conjectures', () => {
    const results = searchSimilarProjectsInCorpus('collatz conjecture', corpus, 5)
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0]?.slug).toBe('collatz')
    expect(results.some(r => r.slug === 'goldbach')).toBe(false)
  })

  it('returns empty for empty query', () => {
    expect(searchSimilarProjectsInCorpus('', corpus)).toEqual([])
  })
})
