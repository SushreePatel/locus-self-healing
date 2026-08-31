/**
 * pom-rewriter.ts — D5: ts-morph AST POM Rewriter
 *
 * Hard constraints (all enforced here):
 *  ✅ AST-level rewriting ONLY — zero regex-based string replacement.
 *  ✅ Only the target locator string literal is modified — no surrounding
 *     code, formatting, or comments are touched.
 *  ✅ validatePOMStructure() runs BEFORE any write operation.
 *  ✅ On validation failure: skip write, return raw suggestion for PR comment.
 *  ✅ If the exact old locator is not found in the file: skip write, return
 *     plain-English error — no partial or guessed patches.
 */

import { Project, SyntaxKind, StringLiteral } from 'ts-morph';
import { validatePOMStructure } from './pom-validator';
import type { ValidationResult } from '../types/shared-types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RewriteInput {
  /** Absolute path to the POM TypeScript file to patch. */
  pomFilePath: string;

  /**
   * The exact locator string currently in the file (the argument to the
   * page.locator() call). Used to find the exact node to patch.
   */
  oldLocator: string;

  /**
   * The new locator string to replace it with.
   */
  newLocator: string;
}

export type RewriteStatus =
  | 'patched'               // AST rewrite succeeded, file saved
  | 'validation-failed'     // File is not a valid POM; patch skipped
  | 'locator-not-found'     // Old locator not found in AST; patch skipped
  | 'write-error';          // IO error saving the file

export interface RewriteResult {
  status: RewriteStatus;

  /** Human-readable explanation — always present, included in PR body/comment. */
  explanation: string;

  /**
   * When status is 'validation-failed' or 'locator-not-found', the raw
   * locator suggestion is returned so the engineer can apply it manually via
   * a PR comment.
   */
  rawSuggestion: string | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find all StringLiteral nodes inside locator() call expressions that match
 * the given `oldLocator` text.
 *
 * We walk the AST looking for:
 *   this.page.locator('...') or this.locator('...')
 * and extract the string argument to compare.
 */
function findLocatorStringLiterals(
  project: Project,
  pomFilePath: string,
  oldLocator: string,
): StringLiteral[] {
  const sourceFile = project.getSourceFileOrThrow(pomFilePath);

  return sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => {
      // Must be a call that includes "locator"
      const expr = call.getExpression();
      return expr.getText().includes('locator');
    })
    .flatMap((call) => {
      // Find string literal arguments that match the old locator exactly
      return call.getArguments().filter((arg): arg is StringLiteral => {
        if (arg.getKind() !== SyntaxKind.StringLiteral) return false;
        const sl = arg as StringLiteral;
        return sl.getLiteralValue() === oldLocator;
      });
    });
}

// ---------------------------------------------------------------------------
// Exported patchLocator function
// ---------------------------------------------------------------------------

/**
 * Patch the `oldLocator` string to `newLocator` inside the given POM file
 * using ts-morph AST rewriting. Never uses regex or string replacement.
 *
 * @param input — POM file path, old locator string, new locator string.
 * @returns RewriteResult describing the outcome.
 */
export async function patchLocator(input: RewriteInput): Promise<RewriteResult> {
  const { pomFilePath, oldLocator, newLocator } = input;

  // ── Step 1: Pre-patch structural validation ──────────────────────────────
  const validation: ValidationResult = validatePOMStructure(pomFilePath);
  if (!validation.valid) {
    return {
      status: 'validation-failed',
      explanation:
        `Locus skipped patching "${pomFilePath}" because the structural validation failed: ` +
        `${validation.reason ?? 'Unknown reason'} ` +
        'The raw locator suggestion is included below — apply it manually.',
      rawSuggestion: newLocator,
    };
  }

  // ── Step 2: Load AST ─────────────────────────────────────────────────────
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false, strict: false },
  });
  project.addSourceFileAtPath(pomFilePath);

  // ── Step 3: Find exact locator node(s) ──────────────────────────────────
  let targets: StringLiteral[];
  try {
    targets = findLocatorStringLiterals(project, pomFilePath, oldLocator);
  } catch (err) {
    return {
      status: 'locator-not-found',
      explanation:
        `Locus could not parse "${pomFilePath}" for locator lookup: ${(err as Error).message}. ` +
        'The raw locator suggestion is included below — apply it manually.',
      rawSuggestion: newLocator,
    };
  }

  if (targets.length === 0) {
    return {
      status: 'locator-not-found',
      explanation:
        `Locus could not find the old locator string "${oldLocator}" inside any ` +
        `locator() call in "${pomFilePath}". This may mean the file has already been ` +
        'updated, or the locator is defined dynamically. ' +
        'The raw locator suggestion is included below — apply it manually.',
      rawSuggestion: newLocator,
    };
  }

  // ── Step 4: AST patch ────────────────────────────────────────────────────
  // Replace ONLY the string literal value. ts-morph preserves all surrounding
  // whitespace, comments, and formatting — nothing else in the file changes.
  // If multiple occurrences are found (e.g., locator reused in several methods),
  // patch all of them.
  for (const literal of targets) {
    // Determine the quote style already used in the file (preserve it)
    const originalText = literal.getText();
    const usesDoubleQuote = originalText.startsWith('"');
    const quote = usesDoubleQuote ? '"' : "'";
    literal.replaceWithText(`${quote}${newLocator}${quote}`);
  }

  // ── Step 5: Save ────────────────────────────────────────────────────────
  try {
    const sourceFile = project.getSourceFileOrThrow(pomFilePath);
    await sourceFile.save();
  } catch (saveErr) {
    return {
      status: 'write-error',
      explanation:
        `Locus generated the AST patch but failed to save "${pomFilePath}": ` +
        `${(saveErr as Error).message}. ` +
        'The raw locator suggestion is included below — apply it manually.',
      rawSuggestion: newLocator,
    };
  }

  return {
    status: 'patched',
    explanation:
      `Successfully patched ${targets.length} occurrence(s) of locator ` +
      `"${oldLocator}" → "${newLocator}" in "${pomFilePath}" via AST rewrite. ` +
      'No other lines were modified.',
    rawSuggestion: undefined,
  };
}
