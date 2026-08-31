/**
 * resolver-types.ts — D4: Typed interface for the Resolver agent.
 *
 * The resolver receives the classifier's output by reference — it does NOT
 * re-fetch or re-calculate confidence. All types are re-exported from
 * shared-types to keep the contract boundary clean.
 */

import type { ClassificationResult } from '../../types/shared-types';

// ---------------------------------------------------------------------------
// Resolver input
// ---------------------------------------------------------------------------

/**
 * Input to the Resolver agent.
 *
 * IMPORTANT: `filteredDiff` and `domSnippet` are the SAME payloads prepared
 * by the reporter and used by the classifier. They are passed through by
 * reference — nothing re-fetches or re-filters them.
 */
export interface ResolverInput {
  /** Full classifier output, including the confidence score and reasoning. */
  classifierOutput: ClassificationResult;

  /** Already-filtered, already-capped diff string from the reporter. */
  filteredDiff: string | null;

  /** DOM snapshot from the reporter (guaranteed non-null at this stage). */
  domSnippet: string;

  /** The locator string currently in the POM (before healing). */
  oldLocator: string;
}

// ---------------------------------------------------------------------------
// Re-export resolver output from shared types
// ---------------------------------------------------------------------------

export type {
  ResolverResult,
  LocatorCandidate,
  LocatorStrategy,
  CandidateGates,
} from '../../types/shared-types';
