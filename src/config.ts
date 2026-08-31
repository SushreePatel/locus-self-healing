/**
 * config.ts — Centralized configuration module
 *
 * ARCHITECTURAL CONSTRAINT (hard rule):
 * This is the ONLY file in the entire Locus codebase that is permitted to read
 * process.env directly. All other modules must import resolved values from here.
 * No other file may call process.env[...] or process.env.VAR_NAME under any
 * circumstances — including test helpers, scripts, or one-off utilities.
 *
 * Authentication: Vertex AI and Firestore SDKs consume Application Default
 * Credentials (ADC) automatically when GOOGLE_APPLICATION_CREDENTIALS is set
 * in the environment. This module does NOT read, embed, or forward that
 * credential file path — it is consumed transparently by the GCP SDKs.
 */

import * as dotenv from 'dotenv';
dotenv.config();

// ---------------------------------------------------------------------------
// Internal helpers — not exported
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[Locus/config] Required environment variable "${name}" is not set. ` +
        `Check your CI workflow env block or local .env file.`,
    );
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

function optionalEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`[Locus/config] Environment variable "${name}" must be an integer, got: "${raw}"`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Exported config object
// ---------------------------------------------------------------------------

export const config = {
  // ─── GCP ────────────────────────────────────────────────────────────────
  gcpProjectId: requireEnv('GCP_PROJECT_ID'),
  gcpRegion: optionalEnv('GCP_REGION', 'us-central1'),

  // ─── Vertex AI / Gemini model tiers ────────────────────────────────────
  // Models are configurable so classifier and resolver can be swapped
  // independently without a code change.
  //
  // NOTE: "gemini-3.1-flash-lite" and "gemini-3.1-pro" are the model IDs
  // specified by the project owner. If Vertex AI returns a "model not found"
  // error, verify availability in your region via:
  //   gcloud ai models list --region=<GCP_REGION>
  classifierModel: optionalEnv('CLASSIFIER_MODEL', 'gemini-3.1-flash-lite'),
  resolverModel: optionalEnv('RESOLVER_MODEL', 'gemini-3.1-pro'),

  // ─── Firestore ──────────────────────────────────────────────────────────
  // Two collections per D8/D9 design:
  //   • elements      — one doc per element; running healCount for budget
  //   • heal-records  — append-only event log; one doc per heal attempt
  firestoreDatabaseId: optionalEnv('FIRESTORE_DATABASE_ID', '(default)'),
  firestoreCollectionElements: optionalEnv('FIRESTORE_COLLECTION_ELEMENTS', 'elements'),
  firestoreCollectionHealRecords: optionalEnv('FIRESTORE_COLLECTION_HEAL_RECORDS', 'heal-records'),

  // ─── GitHub ─────────────────────────────────────────────────────────────
  // GITHUB_TOKEN (standard GH Actions token) is sufficient for all PR creation
  // because merging is always a human UI action — no bot-merge flows exist.
  githubToken: requireEnv('GITHUB_TOKEN'),
  githubRepository: requireEnv('GITHUB_REPOSITORY'), // "owner/repo"
  githubRunId: optionalEnv('GITHUB_RUN_ID', 'local'),
  githubPrNumber: process.env['GITHUB_PR_NUMBER'] ?? undefined,

  // ─── Heal budget (D9) ───────────────────────────────────────────────────
  // Default 3 heals per element; override via HEAL_BUDGET env var.
  healBudget: optionalEnvInt('HEAL_BUDGET', 3),

  // ─── POM discovery (D5) ─────────────────────────────────────────────────
  pomDir: optionalEnv('POM_DIR', 'src'),
  pomGlob: optionalEnv('POM_GLOB', '**/*.page.ts'),

  // ─── Confidence thresholds (D3 hard contract) ───────────────────────────
  // These constants map directly to the confidence band table in the spec.
  // Changing these values changes the contract — do not treat them as tuning.
  confidenceThresholdMinHeal: 60,    // below this → skip, human review
  confidenceThresholdWarningHeal: 80, // 60–79 → amber PR
  confidenceThresholdHighHeal: 95,    // 80–94 → heal with warning, 95+ → high confidence

  // ─── Diff filtering (D2) ────────────────────────────────────────────────
  diffMaxChars: optionalEnvInt('DIFF_MAX_CHARS', 2000),
  diffUiFileExtensions: ['.tsx', '.vue', '.html'] as readonly string[],

  // ─── Webhook / Trigger (D1) ─────────────────────────────────────────────
  webhookSecret: optionalEnv('LOCUS_WEBHOOK_SECRET', ''),
  locusWebhookUrl: optionalEnv('LOCUS_WEBHOOK_URL', 'http://localhost:3000/webhook'),
} as const;

export type Config = typeof config;
