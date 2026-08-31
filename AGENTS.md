# Agent Context & Environment Configuration

## Google Cloud Platform (GCP)
- **Project ID:** `locus-dev-506512`
- **Region:** `us-central1`
- **ADC Path:** `$GOOGLE_APPLICATION_CREDENTIALS`

## Security & Guardrails
- Rely on Application Default Credentials (ADC) for all GCP SDK / Vertex AI calls.
- Never hardcode, commit, or print API keys or private credentials into repository files or terminal outputs.