/**
 * heal-budget.ts — D9: Heal Budget Counter
 *
 * Default budget: 3 heals per element (configurable via HEAL_BUDGET env var).
 *
 * TWO-LAYER PROTECTION — both are required:
 *
 *  Layer 1 — Idempotency:
 *    Before entering the transaction, query heal-records for an existing
 *    document matching this elementId + GITHUB_RUN_ID. If found, a previous
 *    CI run has already processed this element in this CI job — return early.
 *    This prevents a retry of the same CI job from double-counting.
 *
 *  Layer 2 — Atomicity (Firestore transaction):
 *    Read the element record, check healCount, and conditionally increment —
 *    all inside a single Firestore transaction. This prevents two *different*
 *    CI runs (racing on the same element) from both pushing it over budget.
 *
 * Race condition walk-through:
 *   Run A reads healCount=2, Run B reads healCount=2 (both before either writes).
 *   Run A's transaction commits healCount=3 → budget exhausted.
 *   Run B's transaction reads healCount=3 inside the transaction → sees budget
 *   exhausted → returns early without incrementing.
 *   Result: the budget is never exceeded by concurrent runs.
 *
 * raiseRefactorPR stub:
 *   When healCount >= HEAL_BUDGET, this module calls raiseRefactorPR(elementId).
 *   In Phase 1 this is a stub that logs and stops. Phase 2 will implement the
 *   refactor PR body/content generation against this exact contract:
 *     async function raiseRefactorPR(elementId: string): Promise<void>
 */

import { Firestore } from '@google-cloud/firestore';
import { config } from '../config';
import { healRecordExists } from './selector-cache';

// ---------------------------------------------------------------------------
// raiseRefactorPR stub (Phase 2 contract)
// ---------------------------------------------------------------------------

/**
 * STUB — Phase 2 will implement the actual refactor PR body and GitHub API call.
 *
 * Contract (Phase 2 must implement against this signature):
 *   - Receives the elementId of the element that has exhausted its heal budget.
 *   - Raises a GitHub PR with a refactoring suggestion for the entire locator
 *     strategy, not just a point fix.
 *   - Must NOT be called from anywhere other than the budget transaction below.
 *
 * Phase 1 behaviour: logs the invocation and returns immediately.
 */
async function raiseRefactorPR(elementId: string): Promise<void> {
  // STUB — Phase 2 implements this
  console.log(
    `[Locus/heal-budget] raiseRefactorPR STUB called for elementId="${elementId}". ` +
      'Heal budget exhausted. Phase 2 will generate the refactor PR here. ' +
      'No action taken in Phase 1 beyond this log.',
  );
}

// ---------------------------------------------------------------------------
// Firestore client (shared with selector-cache, but kept local here for clarity)
// ---------------------------------------------------------------------------

let _db: Firestore | null = null;

function getDb(): Firestore {
  if (!_db) {
    _db = new Firestore({
      projectId: config.gcpProjectId,
      databaseId: config.firestoreDatabaseId,
    });
  }
  return _db;
}

// ---------------------------------------------------------------------------
// Budget check result types
// ---------------------------------------------------------------------------

export type BudgetCheckStatus =
  | 'ok'                // Budget has space; caller may proceed with healing
  | 'already-processed' // Idempotency layer: this run already processed this element
  | 'budget-exhausted'  // Heal budget reached; raiseRefactorPR stub called
  | 'element-unresolvable'; // Circuit breaker: element is marked unresolvable

export interface BudgetCheckResult {
  status: BudgetCheckStatus;
  healCount: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Exported checkAndIncrementBudget
// ---------------------------------------------------------------------------

/**
 * Atomically check and conditionally increment the heal budget for an element.
 *
 * @param elementId   — Stable element identifier (e.g. "LoginPage.submitButton")
 * @param oldLocator  — Current locator (used to seed the record on first heal)
 * @returns BudgetCheckResult describing whether healing may proceed.
 */
export async function checkAndIncrementBudget(
  elementId: string,
  oldLocator: string,
): Promise<BudgetCheckResult> {
  const ciRunId = config.githubRunId;

  // ── Layer 1: Idempotency check ───────────────────────────────────────────
  // Query heal-records BEFORE the transaction. If a record exists for this
  // elementId + ciRunId, this CI job has already processed this element.
  // Return early without touching the budget counter.
  const alreadyProcessed = await healRecordExists(elementId, ciRunId);
  if (alreadyProcessed) {
    return {
      status: 'already-processed',
      healCount: -1, // unknown without reading elements; not needed here
      reason:
        `Element "${elementId}" was already processed by CI run "${ciRunId}". ` +
        'Idempotency layer prevented double-counting.',
    };
  }

  // ── Layer 2: Atomicity — Firestore transaction ───────────────────────────
  const db = getDb();
  const elementRef = db.collection(config.firestoreCollectionElements).doc(elementId);

  let resultStatus: BudgetCheckStatus = 'ok';
  let finalHealCount = 0;
  let reason = '';

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(elementRef);

    if (!snap.exists) {
      // First time Locus has seen this element — create the record with healCount=0
      // and proceed. The actual increment happens below after the safety checks.
      tx.set(elementRef, {
        elementId,
        healCount: 0,
        status: 'active',
        clearedBy: null,
        locatorHistory: [oldLocator],
        lastUpdated: new Date(),
      });
      // Count is 0, so budget is fine — increment to 1
      tx.update(elementRef, {
        healCount: 1,
        lastUpdated: new Date(),
      });
      finalHealCount = 1;
      resultStatus = 'ok';
      reason = `First heal for element "${elementId}". Budget: 1/${config.healBudget}.`;
      return;
    }

    const data = snap.data() as {
      healCount: number;
      status: string;
      clearedBy: string | null;
      locatorHistory: string[];
    };

    // ── Circuit breaker check ────────────────────────────────────────────
    if (data.status === 'unresolvable') {
      resultStatus = 'element-unresolvable';
      finalHealCount = data.healCount;
      reason =
        `Element "${elementId}" is marked unresolvable in Firestore. ` +
        `clearedBy=${data.clearedBy ?? 'null (not cleared by any human yet)'}. ` +
        'All future failures on this element route to human investigation. ' +
        'Set clearedBy to a GitHub username to re-enable healing.';
      return;
    }

    // ── Budget check ─────────────────────────────────────────────────────
    if (data.healCount >= config.healBudget) {
      // Budget exhausted — call the Phase 2 stub and stop healing.
      // NOTE: raiseRefactorPR is called from inside the transaction's async
      // callback, but it is a stub (logs only) so no atomicity concern.
      resultStatus = 'budget-exhausted';
      finalHealCount = data.healCount;
      reason =
        `Heal budget exhausted for element "${elementId}": ` +
        `healCount=${data.healCount} >= HEAL_BUDGET=${config.healBudget}. ` +
        'raiseRefactorPR stub called. Healing stopped for this element.';
      // Call stub — does not write to Firestore, safe inside transaction
      await raiseRefactorPR(elementId);
      return;
    }

    // ── Increment budget ─────────────────────────────────────────────────
    const newCount = data.healCount + 1;
    tx.update(elementRef, {
      healCount: newCount,
      lastUpdated: new Date(),
    });
    finalHealCount = newCount;
    resultStatus = 'ok';
    reason = `Heal ${newCount}/${config.healBudget} for element "${elementId}".`;
  });

  return {
    status: resultStatus,
    healCount: finalHealCount,
    reason,
  };
}
