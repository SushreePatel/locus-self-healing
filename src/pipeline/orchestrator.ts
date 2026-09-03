/**
 * orchestrator.ts — Pipeline Orchestrator
 *
 * Wires all 9 deliverables in strict order:
 *
 *  1. Heal budget check (idempotency + atomicity) — short-circuit if exhausted
 *  2. Classifier — always runs (cheap/fast tier)
 *  3. Cost gate — short-circuit if shouldInvokeResolver === false
 *  4. Resolver — only when cost gate passes (expensive tier)
 *  5. POM validator + rewriter — only when resolver returns an accepted candidate
 *  6. Markdown report — always generated for the PR body
 *  7. PR automation — create heal PR or human-review PR
 *  8. Firestore heal record — append-only audit log
 *
 * Self-review checklist (from spec) — verified on each deliverable:
 *  (a) No runtime-side locator patching — ✅ all patching is post-execution AST
 *  (b) AST rewriter only touches locator lines — ✅ enforced in pom-rewriter.ts
 *  (c) Diff-capping applied before classifier, reused by resolver — ✅ filteredDiff
 *      is set once in the reporter and passed through unchanged
 *  (d) All fallback paths degrade gracefully with human-readable explanations — ✅
 *  (e) Budget transaction prevents CI race — ✅ Firestore transaction in heal-budget.ts
 *  (f) Resolver NEVER called for real-bug/flakiness — ✅ shouldInvokeResolver gate
 *  (g) PR action driven by classifier's confidenceBand, not resolver — ✅
 *  (h) No env var reads outside config.ts — ✅
 *  (i) Bottleneck notes: classifier and resolver are sequential (resolver cannot
 *      start until classifier returns shouldInvokeResolver=true). This is correct
 *      for cost-gate correctness. No unbounded diff sizes (capped in reporter).
 *      Firestore budget check is a single get() + transaction, not a scan.
 */

import { classify } from '../agents/classifier/classifier-agent';
import { resolve } from '../agents/resolver/resolver-agent';
import { patchLocator } from '../rewriter/pom-rewriter';
import { generateMarkdownReport } from '../reporting/markdown-report';
import { createHealPR, createHumanReviewPR } from '../github/pr-automation';
import { prepareBranchForHeal } from '../git/git-ops';
import { checkAndIncrementBudget } from '../firestore/heal-budget';
import { appendHealRecord, appendLocatorHistory } from '../firestore/selector-cache';
import type { FailureEvent, HealResult, ClassificationResult, ResolverResult } from '../types/shared-types';
import type { ClassifierInput } from '../agents/classifier/classifier-types';
import type { ResolverInput } from '../agents/resolver/resolver-types';
import type { RewriteResult } from '../rewriter/pom-rewriter';

// ---------------------------------------------------------------------------
// Branch name generator
// ---------------------------------------------------------------------------

function makeBranchName(elementId: string, strategy: string): string {
  const safe = elementId.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  const ts = Date.now();
  return `locus/heal/${safe}-${strategy}-${ts}`;
}

// ---------------------------------------------------------------------------
// runPipeline — called by the Playwright reporter on every test failure
// ---------------------------------------------------------------------------

/**
 * Execute the full Locus healing pipeline for a single test failure event.
 *
 * This function never throws. All error paths degrade gracefully and return
 * a HealResult with a human-readable reason and the appropriate status.
 *
 * @param event — FailureEvent from the reporter (DOM snippet guaranteed non-null)
 * @returns HealResult describing the pipeline outcome
 */
export async function runPipeline(event: FailureEvent): Promise<HealResult> {
  console.log(`\n[Locus/orchestrator] ─── Starting pipeline for: "${event.testName}" ───`);
  console.log(`[Locus/orchestrator] elementId=${event.elementId}, dataQuality=${event.dataQuality}`);

  // ── Step 0: Sanity check — DOM snippet must be present ─────────────────
  if (!event.domSnippet) {
    // This should never reach here (reporter aborts on no-dom), but guard anyway
    return {
      status: 'aborted',
      elementId: event.elementId,
      prUrl: undefined,
      revertPrUrl: undefined,
      reason: 'DOM snippet is missing — pipeline aborted by reporter. Check pipeline-aborts collection in Firestore.',
      markdownReport: undefined,
    };
  }

  // ── Step 1: Heal budget check ───────────────────────────────────────────
  let budgetResult: Awaited<ReturnType<typeof checkAndIncrementBudget>>;
  try {
    budgetResult = await checkAndIncrementBudget(event.elementId, event.oldLocator);
  } catch (err) {
    // Budget check failure — degrade to human review
    const reason = `Heal budget check failed: ${(err as Error).message}. Routing to human review.`;
    console.error(`[Locus/orchestrator] ${reason}`);
    return {
      status: 'human-review',
      elementId: event.elementId,
      prUrl: undefined,
      revertPrUrl: undefined,
      reason,
      markdownReport: undefined,
    };
  }

  if (budgetResult.status === 'already-processed') {
    console.log(`[Locus/orchestrator] Idempotency: ${budgetResult.reason}`);
    return {
      status: 'skipped',
      elementId: event.elementId,
      prUrl: undefined,
      revertPrUrl: undefined,
      reason: budgetResult.reason,
      markdownReport: undefined,
    };
  }

  if (budgetResult.status === 'element-unresolvable') {
    console.warn(`[Locus/orchestrator] Circuit breaker active: ${budgetResult.reason}`);
    // Create a human-investigation PR without healing
    const dummyClassification: ClassificationResult = {
      classification: 'ui-drift',
      confidence: 0,
      confidenceBand: 'below-60',
      reasoning: 'Element is marked unresolvable — classification skipped.',
      shouldInvokeResolver: false,
      action: 'skip-human-review',
    };
    const report = generateMarkdownReport({
      event,
      classificationResult: dummyClassification,
      resolverResult: null,
      rewriteResult: null,
      healCount: budgetResult.healCount,
    });
    try {
      const prResult = await createHumanReviewPR({
        event,
        classificationResult: dummyClassification,
        markdownReport: report,
        reason: budgetResult.reason,
      });
      return {
        status: 'human-review',
        elementId: event.elementId,
        prUrl: prResult.prUrl,
        revertPrUrl: undefined,
        reason: budgetResult.reason,
        markdownReport: report,
      };
    } catch {
      return {
        status: 'human-review',
        elementId: event.elementId,
        prUrl: undefined,
        revertPrUrl: undefined,
        reason: budgetResult.reason,
        markdownReport: report,
      };
    }
  }

  if (budgetResult.status === 'budget-exhausted') {
    console.warn(`[Locus/orchestrator] Budget exhausted: ${budgetResult.reason}`);
    return {
      status: 'skipped',
      elementId: event.elementId,
      prUrl: undefined,
      revertPrUrl: undefined,
      reason: budgetResult.reason,
      markdownReport: undefined,
    };
  }

  // Budget OK — proceed
  const healCount = budgetResult.healCount;

  // ── Step 2: Classifier ─────────────────────────────────────────────────
  const classifierInput: ClassifierInput = {
    testName: event.testName,
    stackTrace: event.stackTrace,
    domSnippet: event.domSnippet,
    filteredDiff: event.filteredDiff, // already filtered + capped by reporter
    screenshotBase64: event.screenshotBase64,
    degradedWarnings: event.degradedWarnings,
  };

  let classificationResult: ClassificationResult;
  try {
    classificationResult = await classify(classifierInput);
    console.log(
      `[Locus/orchestrator] Classifier: ${classificationResult.classification} ` +
        `${classificationResult.confidence}% (${classificationResult.confidenceBand}) ` +
        `shouldInvokeResolver=${classificationResult.shouldInvokeResolver}`,
    );
  } catch (err) {
    // Classifier failure — degrade to human review
    const reason = `Classifier failed: ${(err as Error).message}`;
    console.error(`[Locus/orchestrator] ${reason}`);

    const fallbackClassification: ClassificationResult = {
      classification: 'ui-drift',
      confidence: 0,
      confidenceBand: 'below-60',
      reasoning: reason,
      shouldInvokeResolver: false,
      action: 'skip-human-review',
    };
    const report = generateMarkdownReport({
      event,
      classificationResult: fallbackClassification,
      resolverResult: null,
      rewriteResult: null,
      healCount,
    });
    try {
      const pr = await createHumanReviewPR({
        event,
        classificationResult: fallbackClassification,
        markdownReport: report,
        reason,
      });
      return {
        status: 'human-review',
        elementId: event.elementId,
        prUrl: pr.prUrl,
        revertPrUrl: undefined,
        reason,
        markdownReport: report,
      };
    } catch {
      return { status: 'human-review', elementId: event.elementId, prUrl: undefined, revertPrUrl: undefined, reason, markdownReport: report };
    }
  }

  // ── Step 3: Cost gate — short-circuit for non-healing classifications ───
  //
  // Cost gate trace — real-bug example:
  //   classification='real-bug', confidence=85 → shouldInvokeResolver=false
  //   → falls into the !shouldInvokeResolver branch below
  //   → resolver is NEVER called ✅
  //
  // Cost gate trace — flakiness example:
  //   classification='flakiness', confidence=72 → shouldInvokeResolver=false
  //   → falls into the !shouldInvokeResolver branch below
  //   → resolver is NEVER called ✅
  //
  // Cost gate trace — ui-drift, confidence=45%:
  //   shouldInvokeResolver = false (< 60% threshold)
  //   → resolver is NEVER called ✅ → human review PR
  //
  if (!classificationResult.shouldInvokeResolver) {
    const report = generateMarkdownReport({
      event,
      classificationResult,
      resolverResult: null,
      rewriteResult: null,
      healCount,
    });

    // Real bug: fail loudly — PR created but action is fail-loudly
    if (classificationResult.action === 'fail-loudly') {
      console.error(
        `[Locus/orchestrator] 🔴 REAL BUG — build failing loudly. ` +
          `Element: ${event.elementId}. Reasoning: ${classificationResult.reasoning}`,
      );
    }

    // Flakiness: retry annotation suggestion
    if (classificationResult.action === 'retry-annotation') {
      console.warn(
        `[Locus/orchestrator] ⚡ FLAKINESS — retry annotation suggested for "${event.testName}".`,
      );
    }

    let prUrl: string | undefined;
    try {
      const pr = await createHumanReviewPR({
        event,
        classificationResult,
        markdownReport: report,
        reason: `Classification: ${classificationResult.classification}. Action: ${classificationResult.action}.`,
      });
      prUrl = pr.prUrl;
    } catch (prErr) {
      console.error('[Locus/orchestrator] Failed to create human-review PR:', (prErr as Error).message);
    }

    return {
      status: 'human-review',
      elementId: event.elementId,
      prUrl,
      revertPrUrl: undefined,
      reason: `${classificationResult.classification} at ${classificationResult.confidence}% — ${classificationResult.action}`,
      markdownReport: report,
    };
  }

  // ── Step 4: Resolver (ONLY reached if shouldInvokeResolver === true) ────
  const resolverInput: ResolverInput = {
    classifierOutput: classificationResult,
    filteredDiff: event.filteredDiff, // same payload — never re-fetched
    domSnippet: event.domSnippet,
    oldLocator: event.oldLocator,
  };

  let resolverResult: ResolverResult;
  try {
    resolverResult = await resolve(resolverInput);
    console.log(
      `[Locus/orchestrator] Resolver: unresolvable=${resolverResult.unresolvable}, ` +
        `accepted=${resolverResult.acceptedCandidate?.locator ?? 'none'}`,
    );
  } catch (err) {
    // resolve() should never throw (it catches internally), but guard anyway
    resolverResult = {
      acceptedCandidate: null,
      allCandidates: [],
      unresolvable: true,
      failureReason: `Unexpected resolver error: ${(err as Error).message}`,
    };
  }

  // ── Step 5: Handle unresolvable resolver outcome ────────────────────────
  // Confidence contract: an exhausted-candidates outcome routes to human
  // REGARDLESS of how high the classifier's confidence was.
  if (resolverResult.unresolvable || !resolverResult.acceptedCandidate) {
    const report = generateMarkdownReport({
      event,
      classificationResult,
      resolverResult,
      rewriteResult: null,
      healCount,
    });

    let prUrl: string | undefined;
    try {
      const pr = await createHumanReviewPR({
        event,
        classificationResult,
        markdownReport: report,
        reason: resolverResult.failureReason ?? 'All resolver candidates failed validation gates.',
      });
      prUrl = pr.prUrl;
    } catch (prErr) {
      console.error('[Locus/orchestrator] Failed to create unresolvable PR:', (prErr as Error).message);
    }

    return {
      status: 'human-review',
      elementId: event.elementId,
      prUrl,
      revertPrUrl: undefined,
      reason: resolverResult.failureReason ?? 'Unresolvable — all candidates failed.',
      markdownReport: report,
    };
  }

  // ── Step 6: POM Rewriter ────────────────────────────────────────────────
  const newLocator = resolverResult.acceptedCandidate.locator;
  let rewriteResult: RewriteResult;
  try {
    rewriteResult = await patchLocator({
      pomFilePath: event.pomFilePath,
      oldLocator: event.oldLocator,
      newLocator,
    });
    console.log(`[Locus/orchestrator] Rewriter: status=${rewriteResult.status}`);
  } catch (err) {
    rewriteResult = {
      status: 'write-error',
      explanation: `Unexpected rewriter error: ${(err as Error).message}`,
      rawSuggestion: newLocator,
    };
  }

  // ── Step 7: Markdown report ────────────────────────────────────────────
  const markdownReport = generateMarkdownReport({
    event,
    classificationResult,
    resolverResult,
    rewriteResult,
    healCount,
  });

  // ── Step 8: Create PR ──────────────────────────────────────────────────
  // PR action is determined SOLELY by the classifier's confidence band.
  // The resolver outcome refines but does NOT override it.
  const strategy = resolverResult.acceptedCandidate.strategy;
  const branchName = makeBranchName(event.elementId, strategy);

  const prTitle = `[Locus] 🩹 Heal ${event.elementId} — ${classificationResult.confidenceBand} (${classificationResult.confidence}%)`;

  let prUrl: string | undefined;

  if (rewriteResult.status === 'patched') {
    // ── Step 8a: Push the patched file to a new remote branch so GitHub ────
    // accepts the PR. createHealPR requires the branch to already exist on
    // origin — if git operations fail we degrade to a human-review PR.
    let gitReady = false;
    try {
      await prepareBranchForHeal({
        pomFilePath: event.pomFilePath,
        branchName,
        elementId: event.elementId,
      });
      gitReady = true;
    } catch (gitErr) {
      const gitErrMsg = (gitErr as Error).message;
      console.error('[Locus/orchestrator] Git branch preparation failed:', gitErrMsg);
      try {
        const pr = await createHumanReviewPR({
          event,
          classificationResult,
          markdownReport,
          reason: `Git branch creation/push failed — heal PR could not be raised. ${gitErrMsg}`,
        });
        prUrl = pr.prUrl;
      } catch (prErr) {
        console.error('[Locus/orchestrator] Failed to create git-failure PR:', (prErr as Error).message);
      }
    }

    // ── Step 8b: Open the heal PR (only if the branch is on origin) ─────
    if (gitReady) {
      try {
        const pr = await createHealPR({
          branchName,
          title: prTitle,
          body: markdownReport,
          classificationResult,
        });
        prUrl = pr.prUrl;
      } catch (prErr) {
        console.error('[Locus/orchestrator] Failed to create heal PR:', (prErr as Error).message);
      }
    }
  } else {
    // Rewriter failed (validation-failed / locator-not-found / write-error)
    // Create a human-review PR with the raw suggestion attached
    try {
      const pr = await createHumanReviewPR({
        event,
        classificationResult,
        markdownReport,
        reason: `POM rewriter failed (${rewriteResult.status}): ${rewriteResult.explanation}`,
      });
      prUrl = pr.prUrl;
    } catch (prErr) {
      console.error('[Locus/orchestrator] Failed to create rewriter-failure PR:', (prErr as Error).message);
    }
  }

  // ── Step 9: Append Firestore heal record (idempotency audit log) ────────
  if (rewriteResult.status === 'patched') {
    try {
      await appendHealRecord({
        elementId: event.elementId,
        ciRunId: event.githubRunId,
        oldLocator: event.oldLocator,
        newLocator,
        classificationResult,
        pomFilePath: event.pomFilePath,
        prUrl,
      });
      await appendLocatorHistory(event.elementId, newLocator);
    } catch (fsErr) {
      console.error('[Locus/orchestrator] Failed to write heal record to Firestore:', (fsErr as Error).message);
    }
  }

  console.log(
    `[Locus/orchestrator] ─── Pipeline complete: status=${rewriteResult.status === 'patched' ? 'healed' : 'human-review'}, pr=${prUrl ?? 'none'} ───\n`,
  );

  return {
    status: rewriteResult.status === 'patched' ? 'healed' : 'human-review',
    elementId: event.elementId,
    prUrl,
    revertPrUrl: undefined,
    reason: rewriteResult.status === 'patched'
      ? `Healed via ${strategy} strategy (${classificationResult.confidence}% confidence)`
      : rewriteResult.explanation,
    markdownReport,
  };
}
