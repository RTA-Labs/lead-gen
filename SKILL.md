---
name: lead-gen
description: Thesis-agnostic lead generation pipeline. Covers trigger phrases like "lead-gen", "find leads", "prospect", city names + outreach context. Agent orchestrates a 7-phase pipeline; scripts handle deterministic data tasks (Playwright, Apollo, Norbert, embeddings).
---

# Lead Generation (Agent-Orchestrated)

The agent orchestrates a 7-phase lead generation pipeline. The agent performs all LLM reasoning (scoring, ranking, email drafting) directly, while TypeScript scripts handle external APIs and data transformations.

## Installation & Init

### Install the skill
```bash
npx skills add <repo>
```

### Initialize workspace
The agent MUST run init before first pipeline execution. Init is idempotent — safe to run multiple times.

```bash
# Global workspace (default)
npx tsx scripts/init.ts

# Local workspace (project-scoped)
npx tsx scripts/init.ts --local

# Refresh config templates (backs up existing with timestamp)
npx tsx scripts/init.ts --refresh-configs
```

Init creates `~/.lead-gen/` (or `./.lead-gen/` with `--local`) with:
- `.env` file for API keys
- `config/` with thesis.md, email-template.md, filters.md
- `data/`, `output/`, `runs/`, `feedback/` directories
- Installs npm dependencies and Playwright Chromium

### Configure API Keys

Edit `~/.lead-gen/.env`:

**Required:**
- `APOLLO_API_KEY` — Apollo.io (Phase 4: CEO contact enrichment)
- `NORBERT_API_KEY` — VoilaNorbert (Phase 6: Email verification)

**Optional:**
- `OPENAI_API_KEY` — For KB embeddings (if using OpenAI provider)
- `LEAD_GEN_EMBED_PROVIDER=ollama` — Uncomment to use local Ollama instead of OpenAI

**NOT needed:** `ANTHROPIC_API_KEY`, `BRAVE_API_KEY` — the orchestrating agent IS the LLM and has built-in web search.

---

## Usage

```
lead-gen <city> [--limit N] [--resume-from <phase>] [--skip-kb-filter] [--run <run-id>]
```

Options:
- `--limit N` — Maximum companies to shortlist (default: 10)
- `--resume-from <phase>` — Resume from phase number (1-7)
- `--skip-kb-filter` — Skip KB bad-lead filtering
- `--run <run-id>` — Use folder-based run isolation (e.g., `austin-2026-03-31-143022`). All intermediate files are written to `~/.lead-gen/runs/<run-id>/data/` instead of the shared `~/.lead-gen/data/` directory.

Examples:
- `lead-gen Austin --limit 5`
- `lead-gen Austin --resume-from 4`
- `lead-gen Tacoma`
- `lead-gen Austin --run austin-2026-03-31-143022`

---

## Setup Verification

Before running the pipeline, the agent MUST verify readiness:

```bash
npx tsx scripts/status.ts
```

Checks: workspace initialized, API keys set, Playwright installed, config files present, KB status, recent runs. Exit code 0 = ready, 1 = issues.

---

## Pipeline Overview

```
Phase 1: DISCOVER      → Agent web search + URL filtering
Phase 2: CLEAN         → extract → dedupe → [kb validate]
Phase 3: SCORE         → [kb-filter] → Agent scores → shortlist
Phase 4: ENRICH        → enrich → scrape
Phase 5: RANK & DRAFT  → Agent ranks + drafts emails
Phase 6: VERIFY & EXPORT → verify → export
Phase 7: QUALITY CHECK → evaluate → Agent thesis eval
```

**Intermediate files (8 total):**
`2-companies-raw.json` → `3-new-companies.json` → `3-kb-validated.json` (optional) → `5-shortlist.json` → `6-enriched.json` → `7-with-hooks.json` → `10-with-emails.json` → `11-verified.json`

---

## Phase 1: DISCOVER (Agent-Native)

The agent performs discovery directly — no scripts needed.

### Steps:
1. **Read config:** Load `~/.lead-gen/config/thesis.md` and `~/.lead-gen/config/filters.md`
2. **Generate queries:** Based on thesis target profile + target city, generate 4-8 search queries targeting aggregator/list pages. Derive queries from thesis criteria — do NOT hardcode specific sectors.
3. **Web search:** Use web search tool for each query
4. **Filter URLs:** Apply these heuristics:
   - **Include** URLs matching aggregator patterns: `/list`, `/companies`, `/directory`, `/portfolio`, `/firms`, `/startups`, `crunchbase.com`, `pitchbook.com`, `tracxn.com`, `dealroom.co`, `builtin.com`, `f6s.com`, `wellfound.com`
   - **Exclude** domains from `config/filters.md` Aggregator Exclude Domains section
   - **Exclude** individual company pages (e.g., `linkedin.com/company/`, `medium.com/@`)
5. **Pass URLs to extract:**
   ```bash
   npx tsx scripts/extract.ts --urls "url1,url2,url3" --city "<city>"
   ```

### Query generation guidance:
- Target lists/directories, not individual companies
- Vary query structure based on thesis target profile
- Include city name in queries

---

## Phase 2: CLEAN (Scripts)

### Extract (Playwright)

```bash
npx tsx scripts/extract.ts --urls "url1,url2,url3" --city "<city>" [--run-id <id>]
```

**Output:** `2-companies-raw.json`

### Dedupe

```bash
npx tsx scripts/dedupe.ts --input <path-to-2-companies-raw.json> [--run-id <id>]
```

**Output:** `3-new-companies.json`

### KB Validate (optional)

Auto-enabled when `kb.db` exists. Gracefully skips when KB is not available.

```bash
npx tsx scripts/kb-validate.ts --input <path-to-3-new-companies.json> [--threshold 0.40] [--top-k 5]
```

**Output:** `3-kb-validated.json`

---

## Phase 3: FILTER & SCORE (Agent + Optional Script)

### KB Filter (optional)

Only needed when `kb.db` exists and bad-lead filtering is desired.

```bash
npx tsx scripts/kb-filter.ts \
  --input <path-to-3-new-companies.json-or-3-kb-validated.json> \
  [--bad-threshold 0.70]
```

Adds `bad_lead_score` and `bad_lead_filtered` fields. Does NOT call any LLM.

### Agent Scoring

The agent reads companies + `~/.lead-gen/config/thesis.md` and scores each company.

**Scoring Rubric (Generic — score against thesis.md):**

- **9-10**: Exceptional thesis fit. Clearly matches target profile with multiple positive signals.
- **7-8**: Strong thesis fit. Matches target profile, good alignment, minor gaps.
- **5-6**: Moderate fit. Partially matches but uncertain on key criteria.
- **3-4**: Weak fit. Tangentially related. Few positive signals.
- **1-2**: No fit. Matches exclusion criteria.

**Be inclusive:** When in doubt, choose the higher band. Prefer false positives over false negatives.

**Output schema per company:**
```json
{
  "domain": "example.com",
  "name": "Example Corp",
  "agent_score": 8,
  "agent_reasoning": "Strong match against thesis target profile...",
  "bad_lead_filtered": false
}
```

### Shortlist

```bash
npx tsx scripts/shortlist.ts --input <path-to-scored-data.json> --limit N [--run-id <id>]
```

**Output:** `5-shortlist.json`

---

## Phase 4: ENRICH (Scripts)

### Enrich (Apollo API)

```bash
npx tsx scripts/enrich.ts --input <path-to-5-shortlist.json> [--run-id <id>]
```

**Output:** `6-enriched.json`

### Scrape (Playwright)

```bash
npx tsx scripts/scrape.ts --input <path-to-6-enriched.json> [--run-id <id>]
```

**Output:** `7-with-hooks.json`

---

## Phase 5: RANK & DRAFT (Agent-Native)

The agent reads enriched data + hooks + thesis and performs ranking AND email drafting in one pass.

### Classification Guide

- **definite_target**: Clearly matches thesis target profile. Strong evidence of fit across multiple criteria.
- **likely_target**: Strong indicators of thesis fit but some ambiguity. Most criteria match.
- **possible_target**: Could match thesis but significant uncertainty. Limited confirmation on key criteria.

### Scoring Rubric (Full Ranking)

- **9-10**: Exceptional thesis fit. Definite target, strong traction, clear growth indicators.
- **7-8**: Strong thesis fit. Target confirmed or very likely, good alignment.
- **5-6**: Moderate fit. Likely matches thesis but unclear on some key criteria.
- **3-4**: Weak fit. Tangentially related, few positive signals.
- **1-2**: No fit. Matches exclusion criteria.

### Email Drafting

Read `~/.lead-gen/config/email-template.md` for template and `~/.lead-gen/config/thesis.md` Outreach Positioning section for sender context. Draft personalized emails using:
- Hooks from scrape (case studies, testimonials, notable customers, news)
- Thesis positioning (sender name, organization, value proposition)

**Output schema per company:**
```json
{
  "match_type": "definite_target",
  "thesis_score": 8,
  "thesis_reasoning": "Strong match...",
  "email_subject": "Quick question about Example Corp",
  "email_body": "Hi John, ..."
}
```

The agent writes the combined output to `10-with-emails.json` with format:
```json
{
  "city": "Austin",
  "processedAt": "2026-03-30T...",
  "companyCount": 25,
  "companies": [{ ...company_with_all_fields }]
}
```

---

## Phase 6: VERIFY & EXPORT (Scripts)

### Verify (Norbert API)

```bash
npx tsx scripts/verify.ts --input <path-to-10-with-emails.json> [--run-id <id>]
```

**Output:** `11-verified.json`

### Export (SQLite + CSV)

```bash
npx tsx scripts/export.ts --input <path-to-11-verified.json> [--run-id <id>]
```

**Output:** `deals.db` + CSV in output directory

---

## Phase 7: QUALITY CHECK (Agent + Script)

### Script: Filter + KB Evaluation

```bash
npx tsx scripts/evaluate.ts \
  --input <path-to-11-verified.json> --skip-thesis \
  [--kb-threshold 0.40] [--run-id <id>]
```

This runs filter compliance and KB vector evaluation only (no LLM calls).

### Agent: Thesis Evaluation

The agent performs thesis evaluation directly:
1. Sample N companies (default: 20, or all if fewer)
2. For each company, evaluate against `~/.lead-gen/config/thesis.md`:
   - `matchesThesis` (boolean)
   - `confidence` (0-1)
   - `reasoning` (string)
   - `matchedCriteria` (string[])
   - `missingCriteria` (string[])
3. Compute thesis precision = matched / total sampled
4. Identify common missing criteria

### Agent: Compute Grade

Merge script results with agent thesis evaluation:
- **Composite score:** filter (0.2) + KB precision (0.3) + thesis precision (0.5)
- If KB unavailable: filter (0.3) + thesis (0.7)
- If thesis unavailable: filter (0.4) + KB (0.6)

**Grading scale:** A >= 90%, B >= 75%, C >= 60%, D >= 40%, F < 40%

Write final report to `13-evaluation.json`.

---

## Resume Capability

### Checkpoint Detection

Check for existing intermediate files to determine resume point:
```
2-companies-raw.json    → Phase 2 complete (Extract done)
3-new-companies.json    → Phase 2 complete (Dedupe done)
5-shortlist.json        → Phase 3 complete (Scoring done)
6-enriched.json         → Phase 4 in progress
7-with-hooks.json       → Phase 4 complete
10-with-emails.json     → Phase 5 complete
11-verified.json        → Phase 6 in progress
```

### Run Folder Structure

Each pipeline run creates an isolated folder when using `--run`:
```
~/.lead-gen/runs/{runId}/
├── run.json              # Run metadata (status, stats, decisions, issues)
├── data/                 # Intermediate JSON files (2-companies-raw.json, etc.)
├── output/               # Final CSV export
└── context/              # Per-step context (step-2.json, step-3.json, etc.)
```

A global registry at `~/.lead-gen/runs.json` tracks all runs:
```json
{
  "activeRunId": "austin-2026-03-31-143022",
  "runs": [
    {
      "runId": "austin-2026-03-31-143022",
      "city": "Austin",
      "status": "active",
      "currentStep": 5,
      "createdAt": "2026-03-31T14:30:22.000Z",
      "updatedAt": "2026-03-31T15:10:05.000Z"
    }
  ]
}
```

Run management functions are in `scripts/utils/runs.ts`:
- `createRun(city)` — Creates a new run with folders and registry entry
- `loadRun(runId)` / `saveRun(run)` — Read/write `run.json`
- `completeRun(runId)` / `failRun(runId, error)` — Lifecycle transitions
- `buildResumeContext(runId)` — Generates LLM-friendly resume context
- `findRun(query)` — Find run by partial ID or city name
- `getLatestRunForCity(city)` — Get most recent run for a city

---

## Knowledge Base

### Import Historical Leads

```bash
npx tsx scripts/kb-import.ts \
  --good /path/to/good-leads.xlsx \
  --bad /path/to/bad-leads.csv \
  [--provider ollama|openai] [--resume] [--batch-size 100]
```

Auto-detects columns (name, email, description, notes, domain). Supports xlsx/xls/csv. Deduplicates by email_domain.

### Query KB

```bash
npx tsx scripts/kb-query.ts --stats
npx tsx scripts/kb-query.ts --search "query text"
npx tsx scripts/kb-query.ts --similar-to "domain.com"
```

### Pipeline Integration

- **Phase 2** (`kb-validate`): Scores new leads against KB, adds `kb_score`, `kb_match` (strong/moderate/weak), `kb_similar_leads`
- **Phase 3** (`kb-filter`): Hard-filters bad-lead lookalikes using inverse-distance weighted KNN voting

### Post-Run Feedback

After a run completes, the agent can collect feedback:
1. Present run results to user
2. User marks companies as good/bad
3. Agent writes feedback to `feedback/runs/{run_id}/feedback.md`:
   ```markdown
   ---
   run_id: austin-2026-03-30-143022
   city: Austin
   feedback_date: 2026-03-30
   ---

   ## Good
   - Company A (domain-a.com) — Strong thesis fit
   - Company B (domain-b.com) — Great match

   ## Bad
   - Company C (domain-c.com) — Not in our target market
   ```
4. Feedback companies can be imported into KB via `kb-import` for future runs
5. Over time, KB accuracy improves as more feedback accumulates

---

## Configuration

### Investment Thesis (`config/thesis.md`)

```bash
cat ~/.lead-gen/config/thesis.md
```

Define target criteria in natural language. Includes an **Outreach Positioning** section with sender name, organization, role/introduction, value proposition, and call to action. Used by the agent during:
- Phase 1 (query generation)
- Phase 3 (scoring)
- Phase 5 (ranking + email drafting)
- Phase 7 (thesis evaluation)

### Email Template (`config/email-template.md`)

Template with dynamic placeholders:
- `{{company_name}}`, `{{first_name}}`, `{{hook}}`
- `{{sender_positioning}}` (from thesis Outreach Positioning)
- `{{sender_name}}`, `{{sender_organization}}`

### Filters (`config/filters.md`)

Domain filtering rules:
- **Exclude Domains** — social media, aggregators, big tech
- **Exclude Patterns** — mailto:, tel:, javascript:
- **Include Domains** — preferred sources
- **Aggregator Exclude Domains** — excluded from Phase 1 search results

---

## Script Reference

```bash
# Setup
npx tsx scripts/init.ts [--local] [--refresh-configs]
npx tsx scripts/status.ts

# Pipeline steps (add --run <run-id> for folder-based isolation)
npx tsx scripts/extract.ts --urls "url1,url2" --city "Austin" [--run <run-id>]
npx tsx scripts/dedupe.ts --input <file> [--run <run-id>]
npx tsx scripts/shortlist.ts --input <file> --limit 10 [--run <run-id>]
npx tsx scripts/enrich.ts --input <file> [--run <run-id>]
npx tsx scripts/scrape.ts --input <file> [--run <run-id>]
npx tsx scripts/verify.ts --input <file> [--run <run-id>]
npx tsx scripts/export.ts --input <file> [--run <run-id>]
npx tsx scripts/evaluate.ts --input <file> --skip-thesis [--run <run-id>]

# Knowledge base
npx tsx scripts/kb-import.ts --good <file> --bad <file>
npx tsx scripts/kb-query.ts --stats
npx tsx scripts/kb-validate.ts --input <file>
npx tsx scripts/kb-filter.ts --input <file>
```

---

## Prerequisites Table

| Phase | Step | Command | Requires | Notes |
|-------|------|---------|----------|-------|
| 2 | Extract | `npx tsx scripts/extract.ts` | Agent passes URLs via `--urls` | |
| 2 | Dedupe | `npx tsx scripts/dedupe.ts` | 2-companies-raw.json | |
| 2 | KB Validate | `npx tsx scripts/kb-validate.ts` | 3-new-companies.json | Optional, auto if kb.db exists |
| 3 | KB Filter | `npx tsx scripts/kb-filter.ts` | 3-kb-validated.json OR 3-new-companies.json | Optional, no LLM |
| 3 | Shortlist | `npx tsx scripts/shortlist.ts` | Agent-scored data | |
| 4 | Enrich | `npx tsx scripts/enrich.ts` | 5-shortlist.json | APOLLO_API_KEY required |
| 4 | Scrape | `npx tsx scripts/scrape.ts` | 6-enriched.json | Playwright required |
| 6 | Verify | `npx tsx scripts/verify.ts` | 10-with-emails.json | NORBERT_API_KEY required |
| 6 | Export | `npx tsx scripts/export.ts` | 11-verified.json | |
| 7 | Evaluate | `npx tsx scripts/evaluate.ts` | 11-verified.json | Use `--skip-thesis` |

## Database

SQLite at `~/.lead-gen/data/deals.db`:
- Domain-based deduplication
- Historical tracking
- Status management (new → contacted → responded → passed)

## CSV Output Format

```csv
company_name,website,domain,city,industry,employee_count,ceo_name,ceo_title,ceo_email,ceo_linkedin,email_verified,email_confidence,match_type,thesis_score,thesis_reasoning,email_subject,email_body,source
```
