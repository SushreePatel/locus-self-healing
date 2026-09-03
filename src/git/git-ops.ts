/**
 * git-ops.ts — Lightweight git helper for the Locus healing pipeline
 *
 * Provides `prepareBranchForHeal`, which executes the three git steps that
 * must happen before a GitHub PR can be raised:
 *
 *   1. `git checkout -b <branchName>`
 *   2. `git add <filePath>`
 *   3. `git commit -m "..."`
 *   4. `git push -u origin <branchName>`
 *
 * Each step is executed via Node's built-in `child_process.execFile` so there
 * is no additional dependency on `execa` or similar packages.
 *
 * Error handling:
 *  - Non-zero exit codes are surfaced as descriptive `Error` objects that
 *    include the command's stderr, making them easy to log in the orchestrator.
 *  - The caller is responsible for catching these errors and deciding whether
 *    to fall back to a human-review PR.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Internal helper — run a git sub-command and surface stderr on failure
// ---------------------------------------------------------------------------

/**
 * Execute a git command in `cwd`. Resolves with stdout on success; rejects
 * with an Error (including stderr) on non-zero exit.
 */
async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      // Prevent git from opening an editor or pager
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
    });
    return stdout.trim();
  } catch (err) {
    // execFile rejects with an object that has `stderr` and `cmd` on failure
    const e = err as { stderr?: string; cmd?: string; message?: string };
    const detail = e.stderr?.trim() || e.message || String(err);
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PrepareBranchOptions {
  /** Absolute path to the POM/page-object file that was patched. */
  pomFilePath: string;
  /** Branch name to create and push (e.g. "locus/heal/login-btn-css-1234567890"). */
  branchName: string;
  /** Human-readable element identifier — used in the commit message. */
  elementId: string;
  /**
   * Working directory for git commands. Defaults to `process.cwd()`.
   * In CI this should be the root of the checked-out repository.
   */
  cwd?: string;
}

export interface PrepareBranchResult {
  /** The branch that was created and pushed. */
  branchName: string;
  /** Abbreviated SHA of the commit that was made. */
  commitSha: string;
}

/**
 * Create a new heal branch, stage the patched POM file, commit it, and push
 * the branch to `origin`.
 *
 * This must be called AFTER `patchLocator()` has already written the new
 * content to `pomFilePath` on disk, and BEFORE `createHealPR()`.
 *
 * @throws Error if any git operation fails (caller should degrade gracefully)
 */
export async function prepareBranchForHeal(
  options: PrepareBranchOptions,
): Promise<PrepareBranchResult> {
  const { pomFilePath, branchName, elementId, cwd = process.cwd() } = options;

  // ── 1. Create and switch to the new branch ──────────────────────────────
  console.log(`[Locus/git-ops] Creating branch: ${branchName}`);
  await git(['checkout', '-b', branchName], cwd);

  // ── 2. Stage the patched file ───────────────────────────────────────────
  console.log(`[Locus/git-ops] Staging: ${pomFilePath}`);
  await git(['add', pomFilePath], cwd);

  // ── 3. Commit ───────────────────────────────────────────────────────────
  const commitMessage = `heal: update locator for ${elementId}`;
  console.log(`[Locus/git-ops] Committing: "${commitMessage}"`);
  await git(
    [
      'commit',
      '--no-verify', // skip pre-commit hooks so CI self-healing isn't blocked by lint
      '-m',
      commitMessage,
    ],
    cwd,
  );

  // ── 4. Capture the commit SHA (for the result) ──────────────────────────
  const commitSha = await git(['rev-parse', '--short', 'HEAD'], cwd);

  // ── 5. Push the branch to origin ────────────────────────────────────────
  console.log(`[Locus/git-ops] Pushing branch to origin`);
  await git(['push', '-u', 'origin', branchName], cwd);

  console.log(`[Locus/git-ops] Branch ready: ${branchName} @ ${commitSha}`);
  return { branchName, commitSha };
}
