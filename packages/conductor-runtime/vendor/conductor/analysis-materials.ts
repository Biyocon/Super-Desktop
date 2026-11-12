/** Deterministic, bounded source excerpts for a future analysis critic dispatch. */
import type { ConductorMaterialId, IntakeMaterial, ReportCandidate } from './types.ts'
import { captureIntakeMaterial } from './intake.ts'
import { reportHash } from './analysis.ts'

/** One inclusive, one-based range in an admitted material. */
export interface AnalysisMaterialSpan {
  material_id: ConductorMaterialId
  start_line: number
  end_line: number
}

/** Exact text selected from one hash-verified admitted material. */
export interface CriticMaterialExcerpt extends AnalysisMaterialSpan {
  text: string
}

/** Runtime-owned dispatch identity and the candidate's ordered admitted material IDs. */
interface CriticInputIdentity {
  run_id: string
  candidate_hash: string
  candidate_version: string
  critic_child_id: string
  critic_attempt: number
  material_ids: readonly ConductorMaterialId[]
}

/** Inputs needed to build and price the complete critic prompt. */
export interface CriticInputSpec {
  candidate: ReportCandidate
  identity: CriticInputIdentity
  acceptanceCriteria: readonly string[]
  materials: readonly IntakeMaterial[]
  materialSpans: unknown
  instructionText: string
  maxTokens: number
  countTokens: (prompt: string) => number
}

/** Prompt and selected evidence to log before a future critic dispatch. */
export interface CriticInput {
  prompt: string
  tokenCount: number
  excerpts: CriticMaterialExcerpt[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSpans(value: unknown): AnalysisMaterialSpan[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Conductor critic requires material_spans')
  return value.map((raw: unknown) => {
    if (!record(raw) || Object.keys(raw).length !== 3
      || Object.keys(raw).some(key => !['material_id', 'start_line', 'end_line'].includes(key))
      || typeof raw.material_id !== 'string' || !raw.material_id
      || !Number.isSafeInteger(raw.start_line) || Number(raw.start_line) < 1
      || !Number.isSafeInteger(raw.end_line) || Number(raw.end_line) < Number(raw.start_line)) {
      throw new Error('Conductor critic material_span has invalid fields or line range')
    }
    return raw as unknown as AnalysisMaterialSpan
  })
}

function materialLines(content: string): string[] {
  const lines = content.split(/\r\n|\n|\r/)
  // A final line terminator ends the preceding line; it does not create another cited line.
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function selectMaterialSpans(candidate: ReportCandidate, materials: readonly IntakeMaterial[], value: unknown) {
  const materialById = new Map<string, { material: IntakeMaterial; order: number; lines: string[] }>()
  const selectors = new Set<string>()
  for (const [order, material] of materials.entries()) {
    const captured = captureIntakeMaterial(material.selector, material.content, material.sourceMessage)
    if (!material.content.trim() || material.id !== captured.id || material.sha256 !== captured.sha256
      || material.kind !== captured.kind || materialById.has(material.id) || selectors.has(material.selector)) {
      throw new Error('Conductor critic material hash or identity mismatch')
    }
    materialById.set(material.id, { material, order, lines: materialLines(material.content) })
    selectors.add(material.selector)
  }
  const cited = new Set(candidate.material_ids)
  if (cited.size === 0 || cited.size !== candidate.material_ids.length
    || [...cited].some(id => !materialById.has(id))) {
    throw new Error('Conductor critic candidate references unknown or duplicate material')
  }
  const selected = parseSpans(value).map((span) => {
    const source = materialById.get(span.material_id)
    if (!cited.has(span.material_id) || source === undefined || span.end_line > source.lines.length) {
      throw new Error('Conductor critic material_span references unknown or out-of-range material')
    }
    return { span, source }
  })
  if ([...cited].some(id => !selected.some(({ span }) => span.material_id === id))) {
    throw new Error('Conductor critic requires a material_span for every cited material')
  }
  selected.sort((left, right) => left.source.order - right.source.order
    || left.span.start_line - right.span.start_line || left.span.end_line - right.span.end_line)
  let previous: AnalysisMaterialSpan | undefined
  for (const { span } of selected) {
    if (previous !== undefined && previous.material_id === span.material_id && span.start_line <= previous.end_line) {
      throw new Error('Conductor critic material_spans overlap or repeat')
    }
    previous = span
  }
  return {
    excerpts: selected.map(({ span, source }) => ({ ...span, text: source.lines
      .slice(span.start_line - 1, span.end_line).join('\n') })),
    references: [...materialById.values()].filter(({ material }) => cited.has(material.id))
      .map(({ material }) => ({ material_id: material.id, selector: material.selector, sha256: material.sha256 })),
  }
}

/**
 * Validate exact hash-bound material spans before accepting a report candidate.
 * @param candidate - producer candidate with cited material IDs and line ranges.
 * @param materials - immutable admitted material captures.
 * @returns normalized spans in admitted material and line order.
 */
export function validateAnalysisMaterialSpans(candidate: ReportCandidate, materials: readonly IntakeMaterial[]): AnalysisMaterialSpan[] {
  return selectMaterialSpans(candidate, materials, candidate.material_spans).excerpts
    .map(({ material_id, start_line, end_line }) => ({ material_id, start_line, end_line }))
}

/**
 * Verify captured materials and produce one complete, deterministic critic prompt.
 * P2 must log this exact prompt before dispatch; a token overrun rejects the input without truncation.
 * @param spec - validated candidate, admitted capture, untrusted spans and configured token counter/limit.
 * @returns the complete prompt, measured tokens and hash-bound source excerpts.
 */
export function buildCriticInput(spec: CriticInputSpec): CriticInput {
  if (!Number.isSafeInteger(spec.maxTokens) || spec.maxTokens < 1
    || !spec.instructionText.trim() || spec.acceptanceCriteria.length === 0) {
    throw new Error('Conductor critic requires instructions, criteria and a positive token limit')
  }
  const identity = spec.identity
  if (!identity.run_id || identity.run_id.trim() !== identity.run_id
    || !identity.critic_child_id || identity.critic_child_id.trim() !== identity.critic_child_id
    || !Number.isSafeInteger(identity.critic_attempt) || identity.critic_attempt < 1
    || identity.candidate_hash !== reportHash(spec.candidate)
    || identity.candidate_version !== spec.candidate.version
    || !Array.isArray(identity.material_ids)
    || identity.material_ids.length !== spec.candidate.material_ids.length
    || identity.material_ids.some((id, index) => id !== spec.candidate.material_ids[index])) {
    throw new Error('Conductor critic identity must match the candidate and dispatch')
  }
  const { excerpts, references } = selectMaterialSpans(spec.candidate, spec.materials, spec.materialSpans)
  const bound = validateAnalysisMaterialSpans(spec.candidate, spec.materials)
  if (JSON.stringify(excerpts.map(({ material_id, start_line, end_line }) => ({ material_id, start_line, end_line })))
    !== JSON.stringify(bound)) {
    throw new Error('Conductor critic excerpts must match the candidate material_spans')
  }
  const prompt = JSON.stringify({ identity: {
    run_id: identity.run_id, candidate_hash: identity.candidate_hash, candidate_version: identity.candidate_version,
    critic_child_id: identity.critic_child_id, critic_attempt: identity.critic_attempt, material_ids: identity.material_ids,
  }, instructions: spec.instructionText, candidate: spec.candidate,
  acceptance_criteria: spec.acceptanceCriteria, material_references: references, excerpts })
  const tokenCount = spec.countTokens(prompt)
  if (!Number.isSafeInteger(tokenCount) || tokenCount < 1) {
    throw new Error('Conductor critic token counter returned an invalid count')
  }
  if (tokenCount > spec.maxTokens) throw new Error('Conductor critic input exceeds token limit')
  return { prompt, tokenCount, excerpts }
}
