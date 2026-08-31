/**
 * locus-reporter.ts — D2: Custom Playwright Reporter
 *
 * Captures on test failure: screenshot, stack trace, DOM snippet, and the
 * filtered git diff of the triggering change. Implements the explicit data
 * priority decision tree before handing off to the pipeline orchestrator.
 *
 * Installation in playwright.config.ts:
 *   reporter: [['locus-self-healing/dist/reporter/locus-reporter', {}]]
 *
 * Required env vars:
 *   GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_PR_NUMBER (CI only)
 *   GCP_PROJECT_ID (for Firestore abort logging)
 *
 * Teams must also extend the `locusFixtures` in their test setup to capture
 * the DOM snippet and element metadata, then attach them as test attachments.
 * See: src/reporter/README.md for fixture wiring instructions.
 */

import { execSync } from 'child_process';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { Octokit } from '@octokit/rest';
import { Firestore } from '@google-cloud/firestore';
import { config } from '../config';
import type { DegradedInputWarning, DataQuality, FailureEvent } from '../types/shared-types';
import { runPipeline } from '../pipeline/orchestrator';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Filter a raw git diff to UI component files only and cap to DIFF_MAX_CHARS. */
function filterAndCapDiff(rawDiff: string): string {
  const allowedExts = config.diffUiFileExtensions;

  // Split into per-file hunks by the "diff --git" separator
  const hunks = rawDiff.split(/^(?=diff --git)/m);

  const filtered = hunks
    .filter((hunk) => allowedExts.some((ext) => hunk.includes(`${ext}\n`) || hunk.includes(`${ext} `)))
    .join('');

  // Cap at configured limit
  if (filtered.length > config.diffMaxChars) {
    return filtered.slice(0, config.diffMaxChars) + '\n[...diff truncated at 2000 chars by Locus]';
  }
  return filtered;
}

/**
 * Fetch the git diff for a PR via the GitHub API.
 * Returns the filtered, capped diff or null on failure.
 */
async function fetchGitHubPRDiff(prNumber: string): Promise<string | null> {
  try {
    const octokit = new Octokit({ auth: config.githubToken });
    const [owner, repo] = config.githubRepository.split('/');

    const { data: files } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: parseInt(prNumber, 10),
      per_page: 100,
    });

    // Reconstruct a diff-like string from file patches
    const allowedExts = config.diffUiFileExtensions;
    const rawDiff = files
      .filter((f) => allowedExts.some((ext) => f.filename.endsWith(ext)))
      .map((f) => `diff --git a/${f.filename} b/${f.filename}\n${f.patch ?? ''}`)
      .join('\n');

    if (!rawDiff.trim()) return null;

    // Cap at configured limit (already pre-filtered, but still cap)
    return rawDiff.length > config.diffMaxChars
      ? rawDiff.slice(0, config.diffMaxChars) + '\n[...diff truncated at 2000 chars by Locus]'
      : rawDiff;
  } catch (err) {
    console.warn('[Locus/reporter] GitHub API diff fetch failed:', (err as Error).message);
    return null;
  }
}

/**
 * Fallback: obtain diff via `git diff HEAD~1 HEAD` on direct push.
 * Returns the filtered, capped diff or null on failure.
 */
function fetchLocalGitDiff(): string | null {
  try {
    const raw = execSync('git diff HEAD~1 HEAD', { encoding: 'utf8', timeout: 15_000 });
    return filterAndCapDiff(raw);
  } catch (err) {
    console.warn('[Locus/reporter] Local git diff fallback failed:', (err as Error).message);
    return null;
  }
}

/**
 * DATA PRIORITY DECISION TREE
 *
 * This is an explicit decision tree, not ad-hoc null-checks. Every branch
 * produces a fully described DegradedInputWarning when applicable.
 *
 *  1. DOM snippet missing → abort entirely.
 *  2. DOM present + diff missing → proceed, amber warning.
 *  3. DOM present + screenshot missing → proceed, amber warning.
 *  4. All present → full-confidence pipeline.
 */
function buildDataQuality(
  domSnippet: string | null,
  filteredDiff: string | null,
  screenshotBase64: string | null,
): { quality: DataQuality; warnings: DegradedInputWarning[] } {
  const warnings: DegradedInputWarning[] = [];

  // Branch 1 — DOM missing: hard abort
  if (domSnippet === null) {
    return {
      quality: 'no-dom',
      warnings: [
        {
          field: 'domSnippet',
          reason: 'DOM snapshot capture failed or was not attached by the locus fixture.',
          impactOnConfidence:
            'Pipeline aborted. The DOM snippet is the minimum viable input for Locus — ' +
            'without it, the classifier cannot determine whether a locator still exists in ' +
            'the page, so no healing attempt can be made.',
        },
      ],
    };
  }

  // Branch 2 — diff missing
  if (filteredDiff === null) {
    warnings.push({
      field: 'gitDiff',
      reason:
        'Git diff was not available (GitHub API fetch and local git fallback both failed, ' +
        'or no UI component files were changed in this diff).',
      impactOnConfidence:
        'Classifier will proceed without change context. Confidence in "UI drift" classification ' +
        'may be lower than normal because the model cannot cross-reference the DOM change with ' +
        'a specific commit. This PR is marked ⚠️ AMBER — missing diff.',
    });
  }

  // Branch 3 — screenshot missing
  if (screenshotBase64 === null) {
    warnings.push({
      field: 'screenshot',
      reason: 'Screenshot was not captured. Ensure screenshot: "only-on-failure" in playwright.config.',
      impactOnConfidence:
        'Classifier will proceed without visual context. For purely structural DOM changes, ' +
        'this has minimal impact. For visual regressions, confidence may be lower. ' +
        'This PR is marked ⚠️ AMBER — missing screenshot.',
    });
  }

  // Branch 4 — determine final quality
  if (filteredDiff === null && screenshotBase64 === null) {
    return { quality: 'no-diff', warnings }; // worst degraded case that still proceeds
  }
  if (filteredDiff === null) return { quality: 'no-diff', warnings };
  if (screenshotBase64 === null) return { quality: 'no-screenshot', warnings };
  return { quality: 'full', warnings };
}

/** Write a pipeline-abort event to Firestore so it's visible on the dashboard. */
async function logAbortToFirestore(
  testName: string,
  elementId: string,
  reason: string,
  githubRunId: string,
): Promise<void> {
  try {
    const db = new Firestore({
      projectId: config.gcpProjectId,
      databaseId: config.firestoreDatabaseId,
    });
    await db.collection('pipeline-aborts').add({
      testName,
      elementId,
      reason,
      githubRunId,
      timestamp: new Date(),
    });
    console.error(`[Locus/reporter] Pipeline abort logged to Firestore: ${reason}`);
  } catch (fsErr) {
    console.error('[Locus/reporter] Failed to log abort to Firestore:', (fsErr as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Attachment key constants (must match what the locus fixture attaches)
// ---------------------------------------------------------------------------

const ATTACH_DOM_SNIPPET = 'locus-dom-snippet';
const ATTACH_ELEMENT_ID = 'locus-element-id';
const ATTACH_POM_FILE = 'locus-pom-file';
const ATTACH_OLD_LOCATOR = 'locus-old-locator';

// ---------------------------------------------------------------------------
// Reporter class
// ---------------------------------------------------------------------------

/**
 * LocusReporter — Playwright reporter that triggers the Locus healing pipeline
 * on every test failure.
 *
 * Add to playwright.config.ts:
 *   reporter: [['locus-self-healing/dist/reporter/locus-reporter']]
 */
export default class LocusReporter implements Reporter {
  onBegin(): void {
    console.log('[Locus] Reporter initialised. Monitoring for test failures...');
  }

  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    // Only process failures
    if (result.status !== 'failed') return;

    const testName = test.titlePath().join(' > ');
    console.log(`[Locus] Test failure detected: "${testName}"`);

    // ── Extract attachments from the test result ───────────────────────────

    const screenshotAttachment = result.attachments.find(
      (a) => a.name === 'screenshot' && a.contentType === 'image/png',
    );
    const screenshotBase64 = screenshotAttachment?.body
      ? screenshotAttachment.body.toString('base64')
      : null;

    const domAttachment = result.attachments.find((a) => a.name === ATTACH_DOM_SNIPPET);
    const domSnippet = domAttachment?.body ? domAttachment.body.toString('utf8') : null;

    const elementIdAttachment = result.attachments.find((a) => a.name === ATTACH_ELEMENT_ID);
    const elementId = elementIdAttachment?.body
      ? elementIdAttachment.body.toString('utf8')
      : `${test.parent.title}.unknown_element`;

    const pomFileAttachment = result.attachments.find((a) => a.name === ATTACH_POM_FILE);
    const pomFilePath = pomFileAttachment?.body ? pomFileAttachment.body.toString('utf8') : '';

    const oldLocatorAttachment = result.attachments.find((a) => a.name === ATTACH_OLD_LOCATOR);
    const oldLocator = oldLocatorAttachment?.body
      ? oldLocatorAttachment.body.toString('utf8')
      : '';

    // ── Stack trace ────────────────────────────────────────────────────────
    const stackTrace =
      result.errors.map((e) => e.message ?? '').join('\n---\n') || 'No stack trace available';

    // ── Git diff (filtered + capped BEFORE reaching downstream) ───────────
    let filteredDiff: string | null = null;
    if (config.githubPrNumber) {
      filteredDiff = await fetchGitHubPRDiff(config.githubPrNumber);
    }
    if (filteredDiff === null) {
      // Fallback to local git
      filteredDiff = fetchLocalGitDiff();
    }

    // ── Data priority decision tree ────────────────────────────────────────
    const { quality, warnings } = buildDataQuality(domSnippet, filteredDiff, screenshotBase64);

    if (quality === 'no-dom') {
      // Abort the pipeline — DOM is the non-negotiable minimum
      const reason = warnings[0]?.reason ?? 'DOM snippet missing';
      console.error(`[Locus] ABORT: ${reason}`);
      await logAbortToFirestore(testName, elementId, reason, config.githubRunId);
      // Build still fails normally — we don't swallow the test failure
      return;
    }

    // ── Build the FailureEvent (DOM is guaranteed non-null from here) ──────
    const event: FailureEvent = {
      elementId,
      testName,
      pomFilePath,
      oldLocator,
      stackTrace,
      domSnippet: domSnippet as string, // non-null asserted above
      screenshotBase64,
      filteredDiff,
      degradedWarnings: warnings,
      dataQuality: quality,
      githubRunId: config.githubRunId,
      githubPrNumber: config.githubPrNumber,
      timestamp: new Date(),
    };

    if (warnings.length > 0) {
      console.warn(
        `[Locus] Proceeding with degraded inputs (${warnings.map((w) => w.field).join(', ')} missing):`,
      );
      warnings.forEach((w) => console.warn(`  ⚠️  ${w.field}: ${w.reason}`));
    }

    // ── Hand off to the pipeline orchestrator ─────────────────────────────
    try {
      const healResult = await runPipeline(event);
      console.log(`[Locus] Pipeline completed: status=${healResult.status}, pr=${healResult.prUrl ?? 'none'}`);
    } catch (err) {
      // The pipeline itself should never throw (all paths degrade gracefully),
      // but if it does, log loudly and let the test failure propagate normally.
      console.error('[Locus] Unexpected pipeline error:', (err as Error).message);
    }
  }

  onEnd(): void {
    console.log('[Locus] Reporter finished.');
  }
}
