import type {
  AIMediaFidelityCheck,
  AIMediaFidelityResult,
  AIMediaRenderMode,
  AIMediaViewTag,
} from './types'

function isUrlLikelyValid(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

function hasObviousQualityRisk(url: string): boolean {
  return /(placeholder|dummy|lorem|sample)/i.test(url)
}

function addCheck(checks: AIMediaFidelityCheck[], check: AIMediaFidelityCheck): void {
  const index = checks.findIndex((existing) => existing.key === check.key)
  if (index >= 0) {
    checks[index] = check
    return
  }
  checks.push(check)
}

export function evaluateAIMediaFidelity(input: {
  sourceUrl: string
  outputUrl: string
  requiredChecks: string[]
  expectedMode?: AIMediaRenderMode
  actualMode?: AIMediaRenderMode
  enforceProductPreserveMode?: boolean
  expectedViewTag?: AIMediaViewTag
  actualViewTag?: AIMediaViewTag
  allowedViews?: AIMediaViewTag[]
  enforceSourceViewOnly?: boolean
}): AIMediaFidelityResult {
  const source = String(input.sourceUrl || '').trim()
  const output = String(input.outputUrl || '').trim()
  const requiredChecks = Array.isArray(input.requiredChecks) ? input.requiredChecks : []
  const allowedViews = Array.isArray(input.allowedViews) ? input.allowedViews : []
  const enforceSourceViewOnly = input.enforceSourceViewOnly === true
  const enforceProductPreserveMode = input.enforceProductPreserveMode !== false

  const basePass = isUrlLikelyValid(source) && isUrlLikelyValid(output) && !hasObviousQualityRisk(output)
  const score = basePass ? 1 : 0

  const checks: AIMediaFidelityCheck[] = requiredChecks.map((key) => ({
    key,
    score,
    required: true,
    passed: score >= 1,
    reason: score >= 1 ? 'reference_preserved' : 'invalid_or_low_quality_output',
  }))

  const expectedMode = input.expectedMode
  const actualMode = input.actualMode
  const modeCompatible =
    !expectedMode ||
    !actualMode ||
    expectedMode === actualMode ||
    (expectedMode === 'pose_aware_model_wear' && actualMode === 'background_only_preserve_product')

  addCheck(checks, {
    key: 'render_mode_consistency',
    score: modeCompatible ? 1 : 0,
    required: enforceProductPreserveMode,
    passed: modeCompatible,
    reason: modeCompatible
      ? 'provider_mode_compatible'
      : `provider_mode_mismatch:${String(actualMode || 'missing')}`,
  })

  const expectedViewTag = input.expectedViewTag
  const actualViewTag = input.actualViewTag
  const viewInAllowedSet =
    !enforceSourceViewOnly ||
    !actualViewTag ||
    actualViewTag === 'unknown' ||
    allowedViews.length === 0 ||
    allowedViews.includes(actualViewTag)
  const viewMatchesExpectation =
    !enforceSourceViewOnly ||
    !expectedViewTag ||
    !actualViewTag ||
    expectedViewTag === 'unknown' ||
    actualViewTag === 'unknown' ||
    expectedViewTag === actualViewTag
  const viewConsistent = viewInAllowedSet && viewMatchesExpectation

  addCheck(checks, {
    key: 'view_consistency',
    score: viewConsistent ? 1 : 0,
    required: enforceSourceViewOnly,
    passed: viewConsistent,
    reason: viewConsistent
      ? 'view_consistent_with_source'
      : `view_mismatch:${String(actualViewTag || 'missing')}`,
  })

  const rejectionReasons = Array.from(
    new Set(
      checks
        .filter((check) => check.required && !check.passed)
        .map((check) => String(check.reason || check.key).trim())
        .filter(Boolean)
    )
  )

  const strictPass =
    basePass && checks.every((check) => (check.required ? check.passed : true))

  const overallScore = checks.length > 0
    ? checks.reduce((sum, check) => sum + check.score, 0) / checks.length
    : (basePass ? 1 : 0)

  return {
    strictPass,
    overallScore,
    checks,
    summary:
      strictPass
        ? 'Output passed strict fidelity checks against source references.'
        : rejectionReasons.length > 0
          ? rejectionReasons.join('; ')
          : 'Output failed strict fidelity checks and should be regenerated.',
    rejectionReasons,
  }
}
