/**
 * classifier-types.ts — D3: Typed interface for the Classifier agent.
 *
 * The Classifier and Resolver are separate modules with a clearly typed
 * interface between them. This file is the contract boundary.
 */

import type { DegradedInputWarning } from '../../types/shared-types';

// ---------------------------------------------------------------------------
// Classifier input
// ---------------------------------------------------------------------------

/**
 * Everything the Classifier needs. The `filteredDiff` here is the same
 * already-filtered, already-capped string prepared by the reporter — the
 * classifier must NOT re-fetch or re-filter it.
 */
export interface ClassifierInput {
  testName: string;
  stackTrace: string;

  /** DOM snapshot (guaranteed non-null by the time it reaches the classifier). */
  domSnippet: string;

  /**
   * Filtered + capped git diff (may be null if both diff sources failed).
   * The classifier uses it as-is; no further filtering is applied.
   */
  filteredDiff: string | null;

  /** Base64 screenshot, may be null if capture failed. */
  screenshotBase64: string | null;

  /** Degraded-input warnings from the reporter's decision tree. */
  degradedWarnings: DegradedInputWarning[];
}

// ---------------------------------------------------------------------------
// Classifier output = ClassificationResult from shared-types
// (re-exported here for locality; no duplicated definition)
// ---------------------------------------------------------------------------

export type { ClassificationResult } from '../../types/shared-types';
