/**
 * pom-validator.ts — D5: Pre-patch structural validator
 *
 * Runs BEFORE ts-morph touches any file. Must confirm:
 *  1. The target file has at least one class (class-based POM pattern).
 *  2. The target file has at least one call expression containing "locator".
 *
 * If either check fails, the patch is skipped entirely and the raw locator
 * suggestion is returned for a PR comment so the engineer can apply manually.
 *
 * Implements the exact validatePOMStructure() signature specified in the plan.
 */

import { Project, SyntaxKind } from 'ts-morph';
import type { ValidationResult } from '../types/shared-types';

// ---------------------------------------------------------------------------
// Exported validator
// ---------------------------------------------------------------------------

/**
 * Validate that a TypeScript file uses the Page Object Model pattern:
 *  - At least one class declaration.
 *  - At least one call expression that includes the text "locator".
 *
 * @param filePath — Absolute path to the POM TypeScript file.
 * @returns ValidationResult with `valid` flag and optional plain-English `reason`.
 */
export function validatePOMStructure(filePath: string): ValidationResult {
  let project: Project;
  try {
    project = new Project({
      // Only analyse this single file — do not load the whole tsconfig.
      // This keeps validation fast and dependency-free.
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: false,
        strict: false, // Don't fail on type errors — we only need the AST shape
      },
    });
    project.addSourceFileAtPath(filePath);
  } catch (err) {
    return {
      valid: false,
      reason:
        `Locus could not parse the file at "${filePath}": ${(err as Error).message}. ` +
        'Ensure the file is valid TypeScript before Locus attempts to patch it. ' +
        'Manual update required.',
    };
  }

  const sourceFile = project.getSourceFileOrThrow(filePath);

  const hasClasses = sourceFile.getClasses().length > 0;
  const hasLocatorCalls = sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .some((c) => c.getText().includes('locator'));

  if (!hasClasses || !hasLocatorCalls) {
    return {
      valid: false,
      reason:
        'File does not appear to use Page Object Model pattern. ' +
        'Locus requires class-based TypeScript POMs with explicit locator() calls. ' +
        'Manual update required.',
    };
  }

  return { valid: true, reason: undefined };
}
