# Locus — Self-Healing Playwright Test Suite

**Post-execution self-healing tool for Playwright end-to-end tests using a two-agent Gemini architecture on Google Cloud Vertex AI.**

Locus never patches locators silently at runtime. It operates **post-execution**, reads the git diff of the change that broke the test, classifies the failure, and only heals when healing is the correct response. Every fix is written directly into the Page Object Model source file via AST rewriting and shipped as a reviewable GitHub pull request.

---

## Architecture

```
Test Failure
     │
     ▼
[Playwright Reporter (D2)]
  • Captures: screenshot, stack trace, DOM snippet, filtered git diff
  • Applies data priority decision tree
  • Aborts if DOM missing; warns if diff/screenshot missing
     │
     ▼
[Pipeline Orchestrator]
     │
     ├─ [Heal Budget Check (D9)] — idempotency + Firestore transaction
     │
     ├─ [Classifier Agent (D3)] — Gemini Flash-lite (cheap/fast)
     │     Classifies: real-bug | ui-drift | flakiness
     │     Computes: confidence score + band + cost gate flag
     │
     ├─ Cost Gate ─────────────────────────────────────────────────────────
     │     classification == 'ui-drift' AND confidence >= 60%?
     │     NO  → Human review PR (resolver never invoked)
     │     YES ↓
     │
     ├─ [Resolver Agent (D4)] — Gemini Pro (expensive, gated)
     │     Generates: data-testid → ARIA role → unique-text candidates
     │     Validates: existence → uniqueness (critical) → semantic identity
     │
     ├─ [POM Validator + Rewriter (D5)] — ts-morph AST only
     │
     ├─ [Markdown Report (D6)] — single source of truth for PR body
     │
     └─ [PR Automation (D7)] — creates heal/revert/human-review PRs
           + Firestore circuit breaker on post-merge failure
```

## Confidence Band Contract

| Confidence | Classification | Action |
|---|---|---|
| < 60% | Any | Skip healing — human review PR |
| 60–79% | Real bug | Fail build loudly |
| 60–79% | UI drift | Amber PR — requires explicit approval comment |
| 60–79% | Flakiness | Retry annotation suggestion |
| 80–94% | UI drift | Heal with warning note |
| 95–100% | UI drift | Standard heal — auto-label `locus:high-confidence` |

> **Key invariant**: Confidence below 80% never heals silently. It always surfaces to a human.

---

## Installation (as a dev dependency)

```bash
npm install --save-dev locus-self-healing
```

### 1. Configure `playwright.config.ts`

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['list'],
    ['locus-self-healing/dist/reporter/locus-reporter'],
  ],
  use: {
    screenshot: 'only-on-failure',
  },
});
```

### 2. Set environment variables

Create a `.env` file (never commit this):

```bash
GCP_PROJECT_ID=your-project-id
GCP_REGION=us-central1
GITHUB_TOKEN=ghp_...
GITHUB_REPOSITORY=owner/repo
# Optional overrides:
CLASSIFIER_MODEL=gemini-3.1-flash-lite
RESOLVER_MODEL=gemini-3.1-pro
HEAL_BUDGET=3
POM_DIR=src
POM_GLOB=**/*.page.ts
FIRESTORE_DATABASE_ID=(default)
```

### 3. Attach Locus metadata in your tests

Locus needs to know the element ID, POM file, and old locator for each test. Attach them using Playwright test info:

```typescript
// In your test or a shared fixture:
import { test } from '@playwright/test';

test('login button is clickable', async ({ page }, testInfo) => {
  // Attach Locus metadata for healing
  await testInfo.attach('locus-element-id', {
    body: 'LoginPage.submitButton',
    contentType: 'text/plain',
  });
  await testInfo.attach('locus-pom-file', {
    body: path.resolve('src/pages/login.page.ts'),
    contentType: 'text/plain',
  });
  await testInfo.attach('locus-old-locator', {
    body: '[data-testid="submit-btn"]',
    contentType: 'text/plain',
  });
  await testInfo.attach('locus-dom-snippet', {
    body: await page.content(),
    contentType: 'text/html',
  });

  // ... rest of test
});
```

### 4. Set up GitHub Actions

Copy `.github/workflows/locus-ci.yml` into your repository and set the following GitHub Secrets:

| Secret | Description |
|---|---|
| `GCP_PROJECT_ID` | Your GCP project ID |
| `GCP_REGION` | Your GCP region (e.g. `us-central1`) |
| `GCP_SERVICE_ACCOUNT_KEY` | Service account JSON key (for ADC in CI) |
| `LOCUS_WEBHOOK_SECRET` | Optional: webhook signing secret |
| `LOCUS_WEBHOOK_URL` | Webhook endpoint URL |

### 5. Install pre-commit hook

```bash
npx husky install
```

---

## Firestore Collections

| Collection | Purpose |
|---|---|
| `elements` | One document per element — running heal count, status, locator history |
| `heal-records` | Append-only audit log — one document per heal attempt (idempotency) |
| `pipeline-aborts` | Logged when DOM snippet is missing and pipeline cannot proceed |
| `webhook-failures` | Logged when all webhook retries are exhausted |

---

## Security

- All credential access is centralized in `src/config.ts` — **no other file reads `process.env` directly**.
- Authentication uses **Application Default Credentials (ADC)** via `GOOGLE_APPLICATION_CREDENTIALS` — no API keys or credential files are embedded in code.
- **gitleaks** scans every commit (pre-commit hook + CI step), including Locus's own auto-generated PRs.
- `GITHUB_TOKEN` (standard GH Actions token) is sufficient — no PAT or GitHub App needed because all PR merges are human UI actions.

---

## Post-Merge Circuit Breaker

If a healed test fails again after the PR is merged:

1. **Detect**: Post-merge CI job runs the healed test (triggered by `repository_dispatch: locus-post-merge`).
2. **Revert**: Locus immediately raises a revert PR restoring the original locator tagged `locus:revert`.
3. **Circuit break**: Element is marked `status: 'unresolvable'` in Firestore with `clearedBy: null`.

Until a human sets `clearedBy` on the Firestore `elements` document, **all future failures on that element route to a human-investigation PR** — Locus never attempts to heal it automatically.

---

## Phase 1 Scope

This is Phase 1 (Core Pipeline, v1). The following are **explicitly out of scope** and will be addressed in Phase 2/3:

- Multi-run flakiness/drift separation using historical data
- Refactor escalation PRs (stub exists in `heal-budget.ts`)
- BigQuery logging + Looker Studio dashboard
- Cloud Run deployment
- Predictive locator audit
- Slack/Teams notifications