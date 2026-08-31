/**
 * pr-automation.ts — D7: Git PR Automation with Revert / Circuit Breaker
 *
 * Responsibilities:
 *  1. Create a heal PR (or human-review PR) via GitHub REST API.
 *  2. Attach the markdown report as the PR body.
 *  3. Label the PR based on confidence band.
 *  4. Post-merge failure recovery (three-step circuit breaker):
 *       Step 1 — Detect: a locus-post-merge webhook identifies the healed test
 *                failing on re-run (matched by testName + elementId).
 *       Step 2 — Auto-revert: immediately raise a revert PR that restores the
 *                original locator via ts-morph.
 *       Step 3 — Mark unresolvable: write to Firestore. Until a human sets
 *                clearedBy, all future failures on this element route to a
 *                "needs human investigation" PR.
 *
 * Authentication: GITHUB_TOKEN (standard GH Actions token) — sufficient because
 * merging is always a human UI action, never automated. No PAT or GitHub App needed.
 */

import { Octokit } from '@octokit/rest';
import { config } from '../config';
import { patchLocator } from '../rewriter/pom-rewriter';
import { markElementUnresolvable } from '../firestore/selector-cache';
import type { FailureEvent, ClassificationResult } from '../types/shared-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getOctokit(): Octokit {
  return new Octokit({ auth: config.githubToken });
}

function parseRepo(): { owner: string; repo: string } {
  const [owner, repo] = config.githubRepository.split('/');
  if (!owner || !repo) {
    throw new Error(
      `[Locus/pr-automation] GITHUB_REPOSITORY must be in "owner/repo" format, ` +
        `got: "${config.githubRepository}"`,
    );
  }
  return { owner, repo };
}

/** Determine GitHub labels based on confidence band and classification. */
function buildLabels(classificationResult: ClassificationResult): string[] {
  const labels = ['locus:auto-generated'];

  switch (classificationResult.confidenceBand) {
    case 'high-95-100':
      labels.push('locus:high-confidence');
      break;
    case 'warning-80-94':
      labels.push('locus:confidence-warning');
      break;
    case 'amber-60-79':
      labels.push('locus:amber');
      break;
    case 'below-60':
      labels.push('locus:human-review-required');
      break;
  }

  if (classificationResult.classification === 'real-bug') {
    labels.push('locus:real-bug');
  } else if (classificationResult.classification === 'flakiness') {
    labels.push('locus:flakiness');
  }

  return labels;
}

/** Ensure the required Locus labels exist in the repo (idempotent). */
async function ensureLabelsExist(octokit: Octokit, owner: string, repo: string): Promise<void> {
  const labelDefs = [
    { name: 'locus:auto-generated', color: '6f42c1', description: 'Created by Locus self-healing' },
    { name: 'locus:high-confidence', color: '0e8a16', description: 'Locus heal ≥95% confidence' },
    { name: 'locus:confidence-warning', color: 'e4e669', description: 'Locus heal 80–94% confidence' },
    { name: 'locus:amber', color: 'f9a825', description: 'Locus heal 60–79% — requires explicit approval' },
    { name: 'locus:human-review-required', color: 'd93f0b', description: 'Locus: human review required' },
    { name: 'locus:real-bug', color: 'b60205', description: 'Locus: genuine application bug detected' },
    { name: 'locus:flakiness', color: '0075ca', description: 'Locus: flaky test detected' },
    { name: 'locus:revert', color: 'ee0701', description: 'Locus: revert of a failed heal attempt' },
  ];

  for (const label of labelDefs) {
    try {
      await octokit.issues.createLabel({ owner, repo, ...label });
    } catch (err) {
      // 422 = label already exists — that's fine
      const status = (err as { status?: number }).status;
      if (status !== 422) {
        console.warn(`[Locus/pr-automation] Could not create label "${label.name}":`, (err as Error).message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// D7.1: Create heal PR (or human-review PR)
// ---------------------------------------------------------------------------

export interface CreatePROptions {
  branchName: string;
  title: string;
  body: string;
  classificationResult: ClassificationResult;
  baseBranch?: string;
}

export interface CreatePRResult {
  prUrl: string;
  prNumber: number;
}

/**
 * Create a GitHub pull request with the markdown report as the body.
 * Labels are applied based on the confidence band.
 *
 * NOTE: The caller is responsible for having already committed the POM patch
 * to `branchName` before calling this function. pr-automation does not run git.
 */
export async function createHealPR(options: CreatePROptions): Promise<CreatePRResult> {
  const octokit = getOctokit();
  const { owner, repo } = parseRepo();

  // Ensure all Locus labels exist (idempotent)
  await ensureLabelsExist(octokit, owner, repo);

  // Create the PR
  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    title: options.title,
    body: options.body,
    head: options.branchName,
    base: options.baseBranch ?? 'main',
  });

  // Apply labels
  const labels = buildLabels(options.classificationResult);
  await octokit.issues.addLabels({
    owner,
    repo,
    issue_number: pr.number,
    labels,
  });

  console.log(`[Locus/pr-automation] PR created: ${pr.html_url} (labels: ${labels.join(', ')})`);

  return { prUrl: pr.html_url, prNumber: pr.number };
}

/**
 * Create a human-review PR (for cases where Locus cannot heal, or confidence
 * is below threshold). The PR contains the diagnostic report but no locator
 * change.
 */
export async function createHumanReviewPR(params: {
  event: FailureEvent;
  classificationResult: ClassificationResult;
  markdownReport: string;
  reason: string;
}): Promise<CreatePRResult> {
  const { event, classificationResult, markdownReport, reason } = params;
  const octokit = getOctokit();
  const { owner, repo } = parseRepo();

  await ensureLabelsExist(octokit, owner, repo);

  const branchName = `locus/human-review/${event.elementId.replace(/\./g, '-')}-${Date.now()}`;
  const title = `[Locus] 🔍 Human review required: ${event.elementId}`;
  const body =
    `## Locus — Human Review Required\n\n` +
    `**Reason:** ${reason}\n\n` +
    `---\n\n` +
    markdownReport;

  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    title,
    body,
    head: branchName,
    base: 'main',
  }).catch(async (err) => {
    // If branch doesn't exist, we can't create the PR — log and return a placeholder
    console.error(
      `[Locus/pr-automation] Could not create human-review PR (branch "${branchName}" may not exist): ` +
        (err as Error).message,
    );
    // Return a synthetic structure — the pr URL will indicate the error
    return { data: { html_url: `branch-not-found:${branchName}`, number: -1 } };
  });

  await octokit.issues.addLabels({
    owner,
    repo,
    issue_number: pr.number,
    labels: buildLabels(classificationResult),
  }).catch(() => {}); // Labels are best-effort on human-review PRs

  return { prUrl: pr.html_url, prNumber: pr.number };
}

// ---------------------------------------------------------------------------
// D7.2 + D7.3: Post-merge failure recovery (revert + circuit breaker)
// ---------------------------------------------------------------------------

/**
 * Post-merge failure recovery — three steps:
 *
 *  Step 1 (caller's responsibility): Detect that the healed test failed on
 *    the post-merge CI run (matched by testName + elementId via webhook).
 *    Call this function when that match is confirmed.
 *
 *  Step 2 (implemented here): Raise a revert PR that restores the original
 *    locator via ts-morph AST rewrite. PR body states the reason and tags
 *    the PR `locus:revert`.
 *
 *  Step 3 (implemented here): Write `{ elementId, status: 'unresolvable',
 *    reason: 'post-heal re-run failed', clearedBy: null }` to Firestore.
 *    Until a human sets clearedBy, Locus skips this element entirely.
 */
export async function handlePostMergeFailure(params: {
  elementId: string;
  testName: string;
  pomFilePath: string;
  originalLocator: string;
  healedLocator: string;
  markdownReport: string;
}): Promise<{ revertPrUrl: string }> {
  const { elementId, testName, pomFilePath, originalLocator, healedLocator, markdownReport } =
    params;

  console.error(
    `[Locus/pr-automation] Post-merge failure detected for element "${elementId}" ` +
      `in test "${testName}". Initiating revert + circuit breaker.`,
  );

  // ── Step 2: Revert the POM patch via ts-morph ─────────────────────────
  const rewriteResult = await patchLocator({
    pomFilePath,
    oldLocator: healedLocator,   // the healed locator we're reverting FROM
    newLocator: originalLocator, // the original locator we're reverting TO
  });

  if (rewriteResult.status !== 'patched') {
    console.error(
      `[Locus/pr-automation] Revert patch failed (status=${rewriteResult.status}): ` +
        rewriteResult.explanation,
    );
  }

  // ── Create revert PR ──────────────────────────────────────────────────
  const octokit = getOctokit();
  const { owner, repo } = parseRepo();
  await ensureLabelsExist(octokit, owner, repo);

  const revertBranch = `locus/revert/${elementId.replace(/\./g, '-')}-${Date.now()}`;
  const revertTitle = `[Locus] 🔄 REVERT: Heal attempt failed — ${elementId}`;
  const revertBody =
    `## Locus Auto-Revert\n\n` +
    `**Heal attempt failed on re-run. Reverting to original locator.**\n\n` +
    `| Field | Value |\n` +
    `|---|---|\n` +
    `| Element | \`${elementId}\` |\n` +
    `| Test | \`${testName}\` |\n` +
    `| Original locator | \`${originalLocator}\` |\n` +
    `| Healed locator (reverting) | \`${healedLocator}\` |\n` +
    `| Rewrite status | \`${rewriteResult.status}\` |\n\n` +
    `This element has been marked **unresolvable** in Firestore. ` +
    `Future failures on this element will route to a human-investigation PR ` +
    `until \`clearedBy\` is set by a human engineer.\n\n` +
    `---\n\n` +
    `### Original heal report (for context)\n\n` +
    markdownReport;

  let revertPrUrl = `branch-not-created:${revertBranch}`;
  try {
    const { data: revertPr } = await octokit.pulls.create({
      owner,
      repo,
      title: revertTitle,
      body: revertBody,
      head: revertBranch,
      base: 'main',
    });

    await octokit.issues.addLabels({
      owner,
      repo,
      issue_number: revertPr.number,
      labels: ['locus:revert', 'locus:auto-generated'],
    });

    revertPrUrl = revertPr.html_url;
    console.log(`[Locus/pr-automation] Revert PR created: ${revertPrUrl}`);
  } catch (err) {
    console.error(
      `[Locus/pr-automation] Failed to create revert PR: ${(err as Error).message}. ` +
        'Firestore circuit breaker will still be set.',
    );
  }

  // ── Step 3: Mark unresolvable in Firestore (circuit breaker) ──────────
  // This is the CRITICAL step — even if the revert PR fails, the circuit
  // breaker must be set so we don't enter an infinite heal-fail-heal loop.
  await markElementUnresolvable(
    elementId,
    `post-heal re-run failed for test "${testName}". Reverted from "${healedLocator}" to "${originalLocator}".`,
  );

  console.log(
    `[Locus/pr-automation] Circuit breaker SET for element "${elementId}". ` +
      'All future failures on this element will route to human investigation.',
  );

  return { revertPrUrl };
}

// ---------------------------------------------------------------------------
// D7: Add a PR comment (used when POM validation fails — raw suggestion only)
// ---------------------------------------------------------------------------

export async function addPRComment(prNumber: number, body: string): Promise<void> {
  const octokit = getOctokit();
  const { owner, repo } = parseRepo();
  await octokit.issues.createComment({ owner, repo, issue_number: prNumber, body });
}
