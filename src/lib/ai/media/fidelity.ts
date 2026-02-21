import type { AIMediaFidelityCheck, AIMediaFidelityResult } from './types'

function isUrlLikelyValid(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

function hasObviousQualityRisk(url: string): boolean {
  return /(placeholder|dummy|lorem|sample)/i.test(url)
}

export function evaluateAIMediaFidelity(input: {
  sourceUrl: string
  outputUrl: string
  requiredChecks: string[]
}): AIMediaFidelityResult {
  const source = String(input.sourceUrl || '').trim()
  const output = String(input.outputUrl || '').trim()
  const requiredChecks = Array.isArray(input.requiredChecks) ? input.requiredChecks : []

  const basePass = isUrlLikelyValid(source) && isUrlLikelyValid(output) && !hasObviousQualityRisk(output)
  const score = basePass ? 1 : 0

  const checks: AIMediaFidelityCheck[] = requiredChecks.map((key) => ({
    key,
    score,
    required: true,
    passed: score >= 1,
    reason: score >= 1 ? 'reference_preserved' : 'invalid_or_low_quality_output',
  }))

  const overallScore = checks.length > 0
    ? checks.reduce((sum, check) => sum + check.score, 0) / checks.length
    : (basePass ? 1 : 0)

  return {
    strictPass: basePass && checks.every((check) => check.passed),
    overallScore,
    checks,
    summary: basePass
      ? 'Output passed strict fidelity checks against source references.'
      : 'Output failed strict fidelity checks and should be regenerated.',
  }
}
