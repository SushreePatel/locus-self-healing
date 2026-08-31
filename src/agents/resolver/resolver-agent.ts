/**
 * resolver-agent.ts — D4: Resolver Agent (Gemini Pro via Vertex AI)
 *
 * Responsibilities:
 *  1. Invoked ONLY when classifierOutput.shouldInvokeResolver === true.
 *     (This check is enforced by the orchestrator before calling resolve().)
 *  2. Receives the classifier's output + reporter's diff + DOM — nothing is
 *     re-fetched or re-filtered.
 *  3. Generates ranked locator candidates: data-testid → ARIA role → unique-text.
 *  4. Validates each candidate through three gates IN ORDER:
 *       Gate 1 — Existence: element found in captured DOM?
 *       Gate 2 — Uniqueness: matches exactly ONE element? (critical gate)
 *       Gate 3 — Semantic identity: role + accessible name match the original?
 *     On gate failure: discard and try next strategy.
 *  5. If all strategies exhausted → unresolvable = true, route to human.
 *  6. API error / timeout → unresolvable = true with failureReason — no crash.
 *
 * Confidence contract:
 *  The resolver does NOT recalculate or override the classifier's confidence
 *  score. The PR action is always driven by the classifier's confidenceBand.
 *  An exhausted-candidates outcome routes to human regardless of how high the
 *  classifier's confidence was.
 */

import * as cheerio from 'cheerio';
import { VertexAI } from '@google-cloud/vertexai';
import { config } from '../../config';
import type {
  ResolverResult,
  LocatorCandidate,
  LocatorStrategy,
  CandidateGates,
} from '../../types/shared-types';
import type { ResolverInput } from './resolver-types';

// NOTE: cheerio is used for DOM analysis against the captured snapshot.
// It is NOT a live browser — validation runs against the static DOM string
// captured at test-failure time, not against a running Playwright page.
// Add cheerio to devDependencies: npm i -D cheerio

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildResolverPrompt(input: ResolverInput): string {
  const { classifierOutput, filteredDiff, domSnippet, oldLocator } = input;
  return `You are a Playwright locator repair specialist. A UI component was refactored and
the old test locator no longer reliably targets the correct element.

## Context from the classifier
Classification : ${classifierOutput.classification}
Confidence     : ${classifierOutput.confidence}%
Reasoning      : ${classifierOutput.reasoning}

## Old (broken) locator
\`${oldLocator}\`

## Git diff of the UI change (filtered to UI component files only)
${filteredDiff ?? '(Not available)'}

## DOM snapshot at time of failure (first 4000 chars)
\`\`\`html
${domSnippet.slice(0, 4000)}
\`\`\`

## Instructions
Generate up to 3 candidate Playwright locators for the element that the old locator used to target.

Rank them in this EXACT priority order:
  1. data-testid attribute  (e.g. page.getByTestId('submit-btn'))
  2. ARIA role + name       (e.g. page.getByRole('button', { name: 'Submit' }))
  3. Unique visible text    (e.g. page.getByText('Submit', { exact: true }))

Only suggest a candidate if you have reasonable confidence it targets the SAME element
as the original locator. Do NOT suggest generic or ambiguous selectors.

Respond with a JSON array (no markdown fences):
[
  {
    "strategy": "data-testid" | "aria-role" | "unique-text",
    "locator": "<the playwright locator expression>",
    "elementRole": "<ARIA role of the element, if known>",
    "elementName": "<accessible name of the element, if known>"
  }
]

If you cannot generate any candidate, respond with an empty array: []`;
}

// ---------------------------------------------------------------------------
// DOM-based three-gate validation (runs against static captured DOM)
// ---------------------------------------------------------------------------

interface ModelCandidate {
  strategy: LocatorStrategy;
  locator: string;
  elementRole: string;
  elementName: string;
}

/** Parse cheerio-compatible CSS selector from a Playwright locator expression. */
function locatorToCssSelector(locator: string, strategy: LocatorStrategy): string | null {
  switch (strategy) {
    case 'data-testid': {
      // page.getByTestId('foo') → [data-testid="foo"]
      const m = locator.match(/getByTestId\(['"]([^'"]+)['"]\)/);
      return m ? `[data-testid="${m[1]}"]` : null;
    }
    case 'aria-role': {
      // page.getByRole('button', { name: 'Submit' }) → button[aria-label="Submit"] or role=button
      const roleMatch = locator.match(/getByRole\(['"]([^'"]+)['"]/);
      const nameMatch = locator.match(/name:\s*['"]([^'"]+)['"]/);
      if (!roleMatch) return null;
      const role = roleMatch[1];
      if (nameMatch) {
        return `[role="${role}"][aria-label="${nameMatch[1]}"], ${role}`;
      }
      return `[role="${role}"], ${role}`;
    }
    case 'unique-text': {
      // page.getByText('Submit') → match via text content (cheerio text search)
      // Return null — text matching is handled separately
      return null;
    }
  }
}

function validateCandidate(
  domSnippet: string,
  candidate: ModelCandidate,
  originalLocator: string,
): CandidateGates {
  const $ = cheerio.load(domSnippet);

  // ── Gate 1: Existence ──────────────────────────────────────────────────
  let elements: ReturnType<typeof $>;
  if (candidate.strategy === 'unique-text') {
    // Text-based: find elements whose text content matches
    const textMatch = candidate.locator.match(/getByText\(['"]([^'"]+)['"]/);
    if (!textMatch) {
      return { existence: false, uniqueness: false, semanticIdentity: false };
    }
    const searchText = textMatch[1];
    elements = $('*').filter(function () {
      return $(this).text().trim() === searchText;
    });
  } else {
    const selector = locatorToCssSelector(candidate.locator, candidate.strategy);
    if (!selector) {
      return { existence: false, uniqueness: false, semanticIdentity: false };
    }
    // Handle compound selectors (aria-role has "role, tagname" form)
    const selectorParts = selector.split(',').map((s) => s.trim());
    const found = selectorParts.flatMap((s) => {
      try {
        return $(s).toArray();
      } catch {
        return [];
      }
    });
    elements = $(found);
  }

  const existence = elements.length > 0;
  if (!existence) {
    return { existence: false, uniqueness: false, semanticIdentity: false };
  }

  // ── Gate 2: Uniqueness (CRITICAL GATE) ────────────────────────────────
  // A locator matching multiple elements is WORSE than no locator — it
  // silently targets the wrong element. Fail immediately on > 1 match.
  const uniqueness = elements.length === 1;
  if (!uniqueness) {
    console.warn(
      `[Locus/resolver] Uniqueness gate FAILED for strategy "${candidate.strategy}": ` +
        `${elements.length} elements match. Discarding.`,
    );
    return { existence: true, uniqueness: false, semanticIdentity: false };
  }

  // ── Gate 3: Semantic identity ─────────────────────────────────────────
  // Check that the element's role and accessible name match the original's
  // semantic identity as described by the model.
  // This is a best-effort check against the static DOM; it cannot run
  // a full AT. We verify role attribute + aria-label / text content.
  const el = elements.first();
  const elRole = el.attr('role') ?? el.prop('tagName')?.toLowerCase() ?? '';
  const elAriaLabel = el.attr('aria-label') ?? el.text().trim().slice(0, 100);

  let semanticIdentity = true;
  if (candidate.elementRole && elRole) {
    const roleMatch =
      elRole.toLowerCase() === candidate.elementRole.toLowerCase() ||
      el.prop('tagName')?.toLowerCase() === candidate.elementRole.toLowerCase();
    if (!roleMatch) {
      semanticIdentity = false;
    }
  }
  if (semanticIdentity && candidate.elementName && elAriaLabel) {
    const nameMatch = elAriaLabel
      .toLowerCase()
      .includes(candidate.elementName.toLowerCase().slice(0, 30));
    if (!nameMatch) {
      semanticIdentity = false;
    }
  }

  // Cross-reference: also check whether the original locator's target element
  // is the same element (best effort using data-testid or aria-label from old locator)
  const oldTestId = originalLocator.match(/getByTestId\(['"]([^'"]+)['"]\)/)?.[1];
  if (oldTestId) {
    const newTestId = el.attr('data-testid');
    if (newTestId && newTestId !== oldTestId) {
      semanticIdentity = false;
    }
  }

  return { existence: true, uniqueness: true, semanticIdentity };
}

// ---------------------------------------------------------------------------
// Parse model response
// ---------------------------------------------------------------------------

function parseModelCandidates(rawText: string): ModelCandidate[] {
  const cleaned = rawText.replace(/```json\n?|```\n?/g, '').trim();
  const parsed: unknown = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error('Model response is not a JSON array');

  return parsed.map((item, i) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`Candidate ${i} is not an object`);
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj['strategy'] !== 'string') throw new Error(`Candidate ${i}: missing "strategy"`);
    if (typeof obj['locator'] !== 'string') throw new Error(`Candidate ${i}: missing "locator"`);

    const strategy = obj['strategy'] as string;
    if (strategy !== 'data-testid' && strategy !== 'aria-role' && strategy !== 'unique-text') {
      throw new Error(`Candidate ${i}: unknown strategy "${strategy}"`);
    }

    return {
      strategy: strategy as LocatorStrategy,
      locator: obj['locator'] as string,
      elementRole: typeof obj['elementRole'] === 'string' ? obj['elementRole'] : '',
      elementName: typeof obj['elementName'] === 'string' ? obj['elementName'] : '',
    };
  });
}

// ---------------------------------------------------------------------------
// Exported resolve function
// ---------------------------------------------------------------------------

/**
 * Run the Resolver agent.
 *
 * PRECONDITION: Only call this when classifierOutput.shouldInvokeResolver === true.
 * The orchestrator enforces this — call sites must not bypass it.
 *
 * @returns ResolverResult — never throws; all errors produce unresolvable=true.
 */
export async function resolve(input: ResolverInput): Promise<ResolverResult> {
  const vertexAI = new VertexAI({
    project: config.gcpProjectId,
    location: config.gcpRegion,
  });

  const model = vertexAI.getGenerativeModel({
    model: config.resolverModel,
    generationConfig: {
      maxOutputTokens: 1024,
      temperature: 0.2,
    },
  });

  const prompt = buildResolverPrompt(input);

  let rawText: string;
  try {
    const result = await model.generateContent(prompt);
    const candidate = result.response.candidates?.[0];
    rawText = candidate?.content?.parts?.[0]?.text ?? '';
    if (!rawText) {
      throw new Error('Empty response from Vertex AI resolver model');
    }
  } catch (err) {
    // API error / timeout — degrade: mark unresolvable with plain-English reason.
    // Do NOT crash the pipeline.
    const reason =
      `Resolver API call failed: ${(err as Error).message}. ` +
      'The healing candidate could not be generated. Human review required.';
    console.error(`[Locus/resolver] ${reason}`);
    return {
      acceptedCandidate: null,
      allCandidates: [],
      unresolvable: true,
      failureReason: reason,
    };
  }

  // Parse model candidates
  let modelCandidates: ModelCandidate[];
  try {
    modelCandidates = parseModelCandidates(rawText);
  } catch (parseErr) {
    const reason =
      `Failed to parse resolver model response: ${(parseErr as Error).message}. ` +
      `Raw (first 300 chars): ${rawText.slice(0, 300)}`;
    console.error(`[Locus/resolver] ${reason}`);
    return {
      acceptedCandidate: null,
      allCandidates: [],
      unresolvable: true,
      failureReason: reason,
    };
  }

  if (modelCandidates.length === 0) {
    const reason =
      'Resolver model returned no candidates. No suitable locator could be generated ' +
      'from the available DOM and diff context. Human review required.';
    console.warn(`[Locus/resolver] ${reason}`);
    return {
      acceptedCandidate: null,
      allCandidates: [],
      unresolvable: true,
      failureReason: reason,
    };
  }

  // ── Three-gate validation per candidate ─────────────────────────────────
  const evaluatedCandidates: LocatorCandidate[] = [];

  for (const mc of modelCandidates) {
    console.log(`[Locus/resolver] Validating candidate: strategy="${mc.strategy}", locator="${mc.locator}"`);
    const gates = validateCandidate(input.domSnippet, mc, input.oldLocator);

    const candidate: LocatorCandidate = {
      strategy: mc.strategy,
      locator: mc.locator,
      gates,
      accepted: gates.existence && gates.uniqueness && gates.semanticIdentity,
    };
    evaluatedCandidates.push(candidate);

    if (candidate.accepted) {
      console.log(
        `[Locus/resolver] ✅ Candidate accepted: strategy="${mc.strategy}", locator="${mc.locator}"`,
      );
      // Return on first accepted candidate (priority order is maintained by model output order)
      return {
        acceptedCandidate: candidate,
        allCandidates: evaluatedCandidates,
        unresolvable: false,
        failureReason: undefined,
      };
    }

    // Log which gate failed
    if (!gates.existence) {
      console.warn(`[Locus/resolver] ❌ Existence gate failed for "${mc.locator}". Trying next.`);
    } else if (!gates.uniqueness) {
      console.warn(`[Locus/resolver] ❌ Uniqueness gate failed for "${mc.locator}". Trying next.`);
    } else {
      console.warn(`[Locus/resolver] ❌ Semantic identity gate failed for "${mc.locator}". Trying next.`);
    }
  }

  // ── All candidates exhausted ─────────────────────────────────────────────
  // This is unresolvable regardless of how high the classifier's confidence
  // was. Route to human — do NOT downgrade to a lower-confidence band guess.
  const reason =
    `All ${modelCandidates.length} resolver candidate(s) failed at least one validation gate. ` +
    'Strategies attempted: ' +
      evaluatedCandidates.map((c) => `${c.strategy} (existence=${c.gates.existence}, ` +
        `unique=${c.gates.uniqueness}, semantic=${c.gates.semanticIdentity})`).join('; ') +
    '. The element is marked unresolvable. Human review required with DOM context attached.';

  console.error(`[Locus/resolver] ${reason}`);

  return {
    acceptedCandidate: null,
    allCandidates: evaluatedCandidates,
    unresolvable: true,
    failureReason: reason,
  };
}
