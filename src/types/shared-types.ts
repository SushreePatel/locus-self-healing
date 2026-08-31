/**
 * shared-types.ts — Domain types shared across all Locus modules.
 *
 * Import from here; do not duplicate type definitions in individual modules.
 */

// ---------------------------------------------------------------------------
// Classification & Confidence
// ---------------------------------------------------------------------------

/** The three failure classifications the Classifier agent can produce. */
export type ClassificationType = 'real-bug' | 'ui-drift' | 'flakiness';

/**
 * Confidence bands — each band maps to a distinct PR action per the hard
 * contract table in D3. Bands are computed from the classifier's numeric
 * confidence score and never overridden by the resolver.
 */
export type ConfidenceBand =
  | 'below-60'      // < 60  → skip healing, flag for human review
  | 'amber-60-79'   // 60–79 → amber PR, requires explicit approval comment
  | 'warning-80-94' // 80–94 → heal with warning note
  | 'high-95-100';  // 95+   → standard heal, auto-label as high confidence

/** Actions derived from the confidence band × classification lookup table. */
export type BandAction =
  | 'skip-human-review'           // below-60 (any classification)
  | 'fail-loudly'                 // real-bug (any band ≥ 60)
  | 'amber-pr-requires-approval'  // ui-drift + 60–79
  | 'heal-with-warning'           // ui-drift + 80–94
  | 'standard-heal-auto-label'    // ui-drift + 95–100
  | 'retry-annotation';           // flakiness (any band ≥ 60)

// ---------------------------------------------------------------------------
// Data Quality & Degraded Inputs
// ---------------------------------------------------------------------------

/**
 * Summarises what data was available when the reporter ran.
 * Used to propagate context through the pipeline and into the PR body.
 */
export type DataQuality =
  | 'full'            // DOM snippet + git diff + screenshot all present
  | 'no-diff'         // DOM + screenshot present, diff missing
  | 'no-screenshot'   // DOM + diff present, screenshot missing
  | 'no-dom';         // DOM missing — pipeline aborted

/**
 * Plain-English description of a missing or degraded input field.
 * Written into the PR body so the reviewing engineer understands exactly
 * what data was unavailable and how that affected confidence.
 */
export interface DegradedInputWarning {
  field: 'domSnippet' | 'gitDiff' | 'screenshot';
  reason: string;
  impactOnConfidence: string;
}

// ---------------------------------------------------------------------------
// Failure Event (reporter → pipeline)
// ---------------------------------------------------------------------------

/**
 * The canonical payload the reporter hands to the pipeline orchestrator.
 * Everything downstream reads from this struct; nothing re-fetches raw data.
 */
export interface FailureEvent {
  /** Unique, stable identifier for the failing element (e.g. "LoginPage.submitButton"). */
  elementId: string;
  testName: string;

  /** Absolute path to the POM TypeScript file that owns this element's locator. */
  pomFilePath: string;

  /** The locator string currently in the POM (before any healing). */
  oldLocator: string;

  stackTrace: string;

  /**
   * Captured DOM snapshot (page.content(), capped). Non-negotiable minimum
   * viable input — if null, the pipeline is aborted before any agent is called.
   */
  domSnippet: string | null;

  /** Base64-encoded screenshot, or null if capture failed. */
  screenshotBase64: string | null;

  /**
   * Git diff filtered to UI component files only (*.tsx, *.vue, *.html)
   * and capped at DIFF_MAX_CHARS. Applied BEFORE reaching the classifier;
   * the same filtered string is reused by the resolver — it is never re-fetched.
   */
  filteredDiff: string | null;

  degradedWarnings: DegradedInputWarning[];
  dataQuality: DataQuality;

  githubRunId: string;
  githubPrNumber: string | undefined;
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// Classifier output (D3)
// ---------------------------------------------------------------------------

export interface ClassificationResult {
  classification: ClassificationType;

  /** Numeric confidence score from the classifier model, 0–100. */
  confidence: number;

  /** Band computed from `confidence`; drives the final PR action. */
  confidenceBand: ConfidenceBand;

  /** Plain-English reasoning from the model — surfaced in the PR body. */
  reasoning: string;

  /**
   * Cost gate: true IFF classification === 'ui-drift' AND confidence >= 60.
   * Computed inside the classifier module to prevent the orchestrator from
   * bypassing it.
   */
  shouldInvokeResolver: boolean;

  /** The PR action this classification + band maps to (lookup table result). */
  action: BandAction;
}

// ---------------------------------------------------------------------------
// Resolver output (D4)
// ---------------------------------------------------------------------------

export type LocatorStrategy = 'data-testid' | 'aria-role' | 'unique-text';

/** Three-gate validation result for a single candidate. */
export interface CandidateGates {
  existence: boolean;        // element found in DOM?
  uniqueness: boolean;       // matches exactly one element?
  semanticIdentity: boolean; // role + accessible name match original?
}

export interface LocatorCandidate {
  strategy: LocatorStrategy;
  locator: string;
  gates: CandidateGates;
  /** true only if all three gates passed */
  accepted: boolean;
}

export interface ResolverResult {
  /** The first candidate that passed all three gates, or null. */
  acceptedCandidate: LocatorCandidate | null;

  /** All candidates evaluated (for the PR body / audit trail). */
  allCandidates: LocatorCandidate[];

  /**
   * true when all strategies were exhausted without a passing candidate,
   * OR when the resolver call itself failed.
   */
  unresolvable: boolean;

  /**
   * Human-readable reason. Set on:
   * - API error / timeout
   * - All candidates exhausted
   * - No candidates generated
   */
  failureReason: string | undefined;
}

// ---------------------------------------------------------------------------
// Firestore records (D8 / D9)
// ---------------------------------------------------------------------------

/**
 * One document per element in the `elements` collection.
 * Updated atomically inside the heal budget transaction.
 */
export interface ElementRecord {
  elementId: string;
  healCount: number;

  /**
   * 'active'        — element is being healed normally
   * 'unresolvable'  — circuit breaker tripped; all future failures route to human
   */
  status: 'active' | 'unresolvable';

  /**
   * GitHub username or null. Must be set by a human to clear the unresolvable
   * status. Nothing in Phase 1 sets this automatically.
   */
  clearedBy: string | null;

  /** Ordered history of locator values for this element. */
  locatorHistory: string[];

  lastUpdated: Date;
}

/**
 * One document per heal attempt in the `heal-records` collection.
 * Append-only; used only for idempotency checks (elementId + ciRunId).
 */
export interface HealRecord {
  elementId: string;
  ciRunId: string;
  timestamp: Date;
  oldLocator: string;
  newLocator: string;
  classificationResult: ClassificationResult;
  pomFilePath: string;
  prUrl: string | undefined;
}

// ---------------------------------------------------------------------------
// POM Validation (D5)
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  /** Plain-English reason for invalidity — included in PR comment when invalid. */
  reason: string | undefined;
}

// ---------------------------------------------------------------------------
// Top-level HealResult (pipeline output)
// ---------------------------------------------------------------------------

export type HealStatus =
  | 'healed'          // locator patched, PR opened
  | 'skipped'         // not a healing case (flakiness, real bug, budget exhausted)
  | 'human-review'    // confidence too low, or element is unresolvable
  | 'aborted'         // DOM snippet was missing — pipeline cannot proceed
  | 'reverted';       // post-merge re-run failed; revert PR raised

export interface HealResult {
  status: HealStatus;
  elementId: string;
  prUrl: string | undefined;
  revertPrUrl: string | undefined;
  reason: string;
  markdownReport: string | undefined;
}
