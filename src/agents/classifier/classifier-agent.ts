/**
 * classifier-agent.ts — D3: Classifier Agent (Gemini Flash-lite via Vertex AI)
 *
 * Responsibilities:
 *  1. Call the cheap/fast Gemini tier to classify: real-bug | ui-drift | flakiness.
 *  2. Produce the PRIMARY confidence score.
 *  3. Apply the hard confidence band × classification lookup table.
 *  4. Compute `shouldInvokeResolver` (the cost gate) — true IFF:
 *       classification === 'ui-drift' AND confidence >= 60
 *     This gate is computed HERE, not in the orchestrator, so it cannot be bypassed.
 *
 * Cost gate contract (enforced below — not a tuning suggestion):
 *  - Real bug → NEVER invokes resolver; fails build loudly.
 *  - Flakiness → NEVER invokes resolver; suggests retry annotation.
 *  - UI drift + confidence < 60 → NEVER invokes resolver; flags human review.
 *  - UI drift + confidence >= 60 → ONLY case that sets shouldInvokeResolver=true.
 */

import { VertexAI } from '@google-cloud/vertexai';
import { config } from '../../config';
import type {
  ClassificationType,
  ConfidenceBand,
  BandAction,
  ClassificationResult,
} from '../../types/shared-types';
import type { ClassifierInput } from './classifier-types';

// ---------------------------------------------------------------------------
// Confidence band × Classification → Action lookup table (D3 hard contract)
//
// This is a lookup table, not an if/else chain. Each cell maps to exactly one
// action. Changing a cell changes the contract — see the spec's confidence
// band table for the authoritative definition.
// ---------------------------------------------------------------------------

type ActionTable = Record<ConfidenceBand, Record<ClassificationType, BandAction>>;

const ACTION_TABLE: ActionTable = {
  'below-60': {
    'real-bug': 'skip-human-review',
    'ui-drift': 'skip-human-review',
    'flakiness': 'skip-human-review',
  },
  'amber-60-79': {
    'real-bug': 'fail-loudly',
    'ui-drift': 'amber-pr-requires-approval',
    'flakiness': 'retry-annotation',
  },
  'warning-80-94': {
    'real-bug': 'fail-loudly',
    'ui-drift': 'heal-with-warning',
    'flakiness': 'retry-annotation',
  },
  'high-95-100': {
    'real-bug': 'fail-loudly',
    'ui-drift': 'standard-heal-auto-label',
    'flakiness': 'retry-annotation',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeBand(confidence: number): ConfidenceBand {
  if (confidence < 60) return 'below-60';
  if (confidence < 80) return 'amber-60-79';
  if (confidence < 95) return 'warning-80-94';
  return 'high-95-100';
}

function buildPrompt(input: ClassifierInput): string {
  const degradedSummary =
    input.degradedWarnings.length > 0
      ? input.degradedWarnings.map((w) => `- ${w.field}: ${w.reason}`).join('\n')
      : 'None — all inputs present.';

  return `You are a senior QA automation analyst for a self-healing Playwright test tool called Locus.

A Playwright test has just failed. Your task is to classify this failure into EXACTLY ONE of:
  • "real-bug"   — the application itself has a genuine bug that a human engineer must fix
  • "ui-drift"   — a UI component was refactored (selector/label changed) and the test locator is now stale
  • "flakiness"  — the test is timing-sensitive, environment-dependent, or intermittently failing for non-deterministic reasons

## Test name
${input.testName}

## Stack trace
\`\`\`
${input.stackTrace}
\`\`\`

## DOM snapshot (at time of failure)
\`\`\`html
${input.domSnippet.slice(0, 3000)}
\`\`\`

## Git diff of triggering change (filtered to UI component files only, capped at 2000 chars)
${input.filteredDiff ?? '(Not available — diff fetch failed; lower confidence expected)'}

## Degraded input warnings
${degradedSummary}

## Instructions
Respond with a single JSON object. No markdown fences, no explanation outside the JSON.

{
  "classification": "real-bug" | "ui-drift" | "flakiness",
  "confidence": <integer 0-100>,
  "reasoning": "<plain-English explanation, 2-4 sentences, suitable for a PR comment>"
}

Rules:
- confidence must reflect genuine model uncertainty, not always be high
- if the diff is missing, reduce confidence appropriately
- for real-bug: explain what application behaviour is broken
- for ui-drift: identify which selector or label changed
- for flakiness: describe the non-deterministic signal (timing, network, etc.)`;
}

// ---------------------------------------------------------------------------
// Model response parser
// ---------------------------------------------------------------------------

interface RawModelResponse {
  classification: string;
  confidence: number;
  reasoning: string;
}

function parseModelResponse(raw: string): RawModelResponse {
  // Strip markdown fences if the model wraps the JSON anyway
  const cleaned = raw.replace(/```json\n?|```\n?/g, '').trim();
  const parsed: unknown = JSON.parse(cleaned);

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Model response is not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj['classification'] !== 'string') throw new Error('Missing or invalid "classification"');
  if (typeof obj['confidence'] !== 'number') throw new Error('Missing or invalid "confidence"');
  if (typeof obj['reasoning'] !== 'string') throw new Error('Missing or invalid "reasoning"');

  return {
    classification: obj['classification'] as string,
    confidence: obj['confidence'] as number,
    reasoning: obj['reasoning'] as string,
  };
}

function assertClassificationType(raw: string): ClassificationType {
  if (raw === 'real-bug' || raw === 'ui-drift' || raw === 'flakiness') {
    return raw;
  }
  throw new Error(`Unknown classification value from model: "${raw}"`);
}

// ---------------------------------------------------------------------------
// Exported classify function
// ---------------------------------------------------------------------------

/**
 * Run the Classifier agent.
 *
 * @param input — Prepared by the orchestrator from FailureEvent; never
 *   contains raw/uncapped diffs.
 * @returns ClassificationResult including the cost gate flag shouldInvokeResolver.
 * @throws Only on unrecoverable SDK errors — the caller should catch and
 *   degrade gracefully.
 */
export async function classify(input: ClassifierInput): Promise<ClassificationResult> {
  const vertexAI = new VertexAI({
    project: config.gcpProjectId,
    location: config.gcpRegion,
  });

  const model = vertexAI.getGenerativeModel({
    model: config.classifierModel,
    generationConfig: {
      maxOutputTokens: 512,
      temperature: 0.1, // low temperature for consistent classification
    },
  });

  const prompt = buildPrompt(input);

  let rawText: string;
  try {
    const result = await model.generateContent(prompt);
    const candidate = result.response.candidates?.[0];
    rawText = candidate?.content?.parts?.[0]?.text ?? '';
    if (!rawText) {
      throw new Error('Empty response from Vertex AI classifier model');
    }
  } catch (err) {
    // API error — degrade: classify as flakiness with 0% confidence so no
    // resolver is ever called and the failure surfaces to human review.
    console.error('[Locus/classifier] Vertex AI call failed:', (err as Error).message);
    throw new Error(
      `[Locus/classifier] Vertex AI call failed: ${(err as Error).message}. ` +
        'Degrading to human review.',
    );
  }

  // Parse model response
  let parsed: RawModelResponse;
  try {
    parsed = parseModelResponse(rawText);
  } catch (parseErr) {
    throw new Error(
      `[Locus/classifier] Failed to parse model response: ${(parseErr as Error).message}. ` +
        `Raw response (first 500 chars): ${rawText.slice(0, 500)}`,
    );
  }

  const classification = assertClassificationType(parsed.classification);
  // Clamp confidence to [0, 100]
  const confidence = Math.min(100, Math.max(0, Math.round(parsed.confidence)));
  const confidenceBand = computeBand(confidence);
  const action = ACTION_TABLE[confidenceBand][classification];

  // ── Cost gate (hard rule) ────────────────────────────────────────────────
  // The resolver is ONLY invoked when:
  //   classification === 'ui-drift' AND confidence >= config.confidenceThresholdMinHeal
  // Anything else — real bugs, flakiness, or low-confidence drift — short-circuits
  // here. The resolver pays for itself only on the narrow case where healing makes sense.
  const shouldInvokeResolver =
    classification === 'ui-drift' && confidence >= config.confidenceThresholdMinHeal;

  // ── Loud logging for real bugs ───────────────────────────────────────────
  if (classification === 'real-bug') {
    console.error(
      `[Locus/classifier] 🔴 REAL BUG detected (confidence=${confidence}%). ` +
        `Build will fail. Resolver NOT invoked. Reasoning: ${parsed.reasoning}`,
    );
  } else if (classification === 'flakiness') {
    console.warn(
      `[Locus/classifier] ⚡ FLAKINESS detected (confidence=${confidence}%). ` +
        `Resolver NOT invoked. Suggestion: add retry annotation.`,
    );
  } else if (!shouldInvokeResolver) {
    // ui-drift but below threshold
    console.warn(
      `[Locus/classifier] ⚠️ UI DRIFT but confidence=${confidence}% is below ` +
        `threshold (${config.confidenceThresholdMinHeal}%). Resolver NOT invoked. ` +
        `Routing to human review.`,
    );
  } else {
    console.log(
      `[Locus/classifier] ✅ UI DRIFT, confidence=${confidence}% (${confidenceBand}). ` +
        `Resolver WILL be invoked.`,
    );
  }

  return {
    classification,
    confidence,
    confidenceBand,
    reasoning: parsed.reasoning,
    shouldInvokeResolver,
    action,
  };
}
