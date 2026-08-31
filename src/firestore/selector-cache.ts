/**
 * selector-cache.ts — D8: Firestore Selector Cache
 *
 * Explicitly replaces Redis. No other cache layer exists in Locus.
 *
 * Collections:
 *  • elements      — One document per element (keyed by elementId).
 *                    Stores running healCount, status, locator history.
 *                    Read/incremented inside an atomic Firestore transaction by heal-budget.ts.
 *
 *  • heal-records  — Append-only event log. One document per heal attempt.
 *                    Used ONLY for idempotency checks (elementId + ciRunId).
 *                    Never mutated after creation.
 *
 * Authentication: Firestore SDK consumes ADC transparently.
 * Do NOT read GOOGLE_APPLICATION_CREDENTIALS here — config.ts owns that context.
 */

import { Firestore, FieldValue } from '@google-cloud/firestore';
import { config } from '../config';
import type { ElementRecord, HealRecord, ClassificationResult } from '../types/shared-types';

// ---------------------------------------------------------------------------
// Firestore client singleton (lazy-initialised)
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
// elements collection helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve an ElementRecord by elementId, or null if it doesn't exist yet.
 * READ-ONLY — do not call this inside a transaction where you need consistency.
 */
export async function getElementRecord(elementId: string): Promise<ElementRecord | null> {
  const db = getDb();
  const snap = await db.collection(config.firestoreCollectionElements).doc(elementId).get();
  if (!snap.exists) return null;
  const data = snap.data() as ElementRecord;
  return data;
}

/**
 * Create a fresh ElementRecord for a brand-new element.
 * Only call this when no record exists yet.
 */
export async function createElementRecord(
  elementId: string,
  initialLocator: string,
): Promise<void> {
  const db = getDb();
  const record: ElementRecord = {
    elementId,
    healCount: 0,
    status: 'active',
    clearedBy: null,
    locatorHistory: [initialLocator],
    lastUpdated: new Date(),
  };
  await db.collection(config.firestoreCollectionElements).doc(elementId).set(record);
}

/**
 * Mark an element as unresolvable after a post-merge failure.
 * Sets status = 'unresolvable' and clearedBy = null.
 * clearedBy must be set by a human — nothing in Phase 1 sets it automatically.
 */
export async function markElementUnresolvable(
  elementId: string,
  reason: string,
): Promise<void> {
  const db = getDb();
  await db.collection(config.firestoreCollectionElements).doc(elementId).set(
    {
      status: 'unresolvable',
      clearedBy: null,
      unresolvableReason: reason,
      unresolvableAt: new Date(),
      lastUpdated: new Date(),
    },
    { merge: true },
  );
  console.log(`[Locus/selector-cache] Element "${elementId}" marked unresolvable: ${reason}`);
}

/**
 * Append a new locator to the element's history (used after a successful patch).
 * This is a non-transactional append — the atomic increment is in heal-budget.ts.
 */
export async function appendLocatorHistory(
  elementId: string,
  newLocator: string,
): Promise<void> {
  const db = getDb();
  await db.collection(config.firestoreCollectionElements).doc(elementId).update({
    locatorHistory: FieldValue.arrayUnion(newLocator),
    lastUpdated: new Date(),
  });
}

// ---------------------------------------------------------------------------
// heal-records collection helpers (append-only)
// ---------------------------------------------------------------------------

/**
 * Check whether a heal record already exists for this elementId + ciRunId.
 * Used as the idempotency check — if this returns true, the run has already
 * processed this element and should return early.
 */
export async function healRecordExists(
  elementId: string,
  ciRunId: string,
): Promise<boolean> {
  const db = getDb();
  const snap = await db
    .collection(config.firestoreCollectionHealRecords)
    .where('elementId', '==', elementId)
    .where('ciRunId', '==', ciRunId)
    .limit(1)
    .get();
  return !snap.empty;
}

/**
 * Append a heal attempt record to the heal-records collection.
 * This document is NEVER updated after creation — it is an audit log entry.
 */
export async function appendHealRecord(params: {
  elementId: string;
  ciRunId: string;
  oldLocator: string;
  newLocator: string;
  classificationResult: ClassificationResult;
  pomFilePath: string;
  prUrl: string | undefined;
}): Promise<void> {
  const db = getDb();
  const record: HealRecord = {
    elementId: params.elementId,
    ciRunId: params.ciRunId,
    timestamp: new Date(),
    oldLocator: params.oldLocator,
    newLocator: params.newLocator,
    classificationResult: params.classificationResult,
    pomFilePath: params.pomFilePath,
    prUrl: params.prUrl,
  };
  await db.collection(config.firestoreCollectionHealRecords).add(record);
}

/**
 * Log a pipeline abort event. Used when DOM snippet is missing and the
 * pipeline cannot proceed. Written to a separate 'pipeline-aborts' collection
 * so aborts don't pollute the heal-records audit log.
 */
export async function logPipelineAbort(params: {
  testName: string;
  elementId: string;
  reason: string;
  githubRunId: string;
}): Promise<void> {
  const db = getDb();
  try {
    await db.collection('pipeline-aborts').add({
      ...params,
      timestamp: new Date(),
    });
  } catch (err) {
    console.error('[Locus/selector-cache] Failed to log pipeline abort:', (err as Error).message);
  }
}
