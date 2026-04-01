#!/usr/bin/env npx tsx
/**
 * enrich.ts — Step 6: Apollo.io API enrichment for shortlisted companies.
 *
 * Looks up the CEO/Founder for each company by domain, then does a full
 * person-level reveal to get the email address.
 *
 * Usage:
 *   enrich.ts --input 5-shortlist.json
 *   enrich.ts --input 5-shortlist.json --run-id 42
 *
 * Output: <dataDir>/6-enriched.json
 */

import fs from 'fs';
import path from 'path';
import { apolloEnrichByDomain, apolloEnrichById } from './utils/api-clients.js';
import { runStep, parseRunId, parseRunFolder, getDataDir, STEP_NAMES, type StepOutput } from './utils/step-runner.js';

const STEP_NUMBER = 6;
const DEFAULT_INPUT = '5-shortlist.json';
const OUTPUT_FILE = '6-enriched.json';

// Delay between Apollo API calls to respect rate limits
const API_DELAY_MS = 500;

interface ShortlistCompany {
  name: string;
  domain: string;
  website?: string;
  description?: string;
  city?: string;
  source?: string;
  score?: number;
  match_type?: string;
  [key: string]: unknown;
}

interface EnrichedCompany extends ShortlistCompany {
  ceo_first_name?: string;
  ceo_last_name?: string;
  ceo_title?: string;
  ceo_email?: string;
  ceo_linkedin?: string;
  employee_count?: number;
  industry?: string;
  company_linkedin?: string;
  enriched_at?: string;
  enrich_status?: 'found' | 'no_person' | 'error';
}

/* ── CLI arg parsing ─────────────────────────────────────────────── */

function parseArgs(): { inputFile: string; runId?: number; runFolder?: string } {
  const args = process.argv.slice(2);
  const i = args.indexOf('--input');
  const runId = parseRunId(args);
  const runFolder = parseRunFolder(args);

  let inputFile = i !== -1 ? args[i + 1] : DEFAULT_INPUT;
  if (!path.isAbsolute(inputFile)) {
    inputFile = path.join(getDataDir(runFolder), inputFile);
  }

  return { inputFile, runId, runFolder };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ── Enrichment logic ────────────────────────────────────────────── */

async function enrichCompany(company: ShortlistCompany): Promise<EnrichedCompany> {
  const enriched: EnrichedCompany = { ...company };

  try {
    // Step 1: Find the CEO/Founder by domain
    const personMatch = await apolloEnrichByDomain(company.domain);

    if (!personMatch) {
      enriched.enrich_status = 'no_person';
      return enriched;
    }

    // Populate basic fields from the search result
    enriched.ceo_first_name = personMatch.first_name ?? undefined;
    enriched.ceo_last_name = personMatch.last_name ?? undefined;
    enriched.ceo_title = personMatch.title ?? undefined;
    enriched.ceo_linkedin = personMatch.linkedin_url ?? undefined;

    if (personMatch.organization) {
      enriched.employee_count = personMatch.organization.estimated_num_employees ?? undefined;
      enriched.industry = personMatch.organization.industry ?? undefined;
    }

    // Step 2: If we have a person ID, do a full reveal to get the email
    if (personMatch.id) {
      await sleep(API_DELAY_MS);
      const fullPerson = await apolloEnrichById(personMatch.id);

      if (fullPerson) {
        enriched.ceo_first_name = fullPerson.first_name ?? enriched.ceo_first_name;
        enriched.ceo_last_name = fullPerson.last_name ?? enriched.ceo_last_name;
        enriched.ceo_title = fullPerson.title ?? enriched.ceo_title;
        enriched.ceo_email = fullPerson.email ?? undefined;
        enriched.ceo_linkedin = fullPerson.linkedin_url ?? enriched.ceo_linkedin;

        if (fullPerson.organization) {
          enriched.employee_count = fullPerson.organization.estimated_num_employees ?? enriched.employee_count;
          enriched.industry = fullPerson.organization.industry ?? enriched.industry;
        }
      }
    } else if (personMatch.has_email && personMatch.email) {
      enriched.ceo_email = personMatch.email;
    }

    enriched.enrich_status = 'found';
    enriched.enriched_at = new Date().toISOString();
  } catch (err) {
    console.error(`  Error enriching ${company.domain}:`, err instanceof Error ? err.message : err);
    enriched.enrich_status = 'error';
  }

  return enriched;
}

/* ── Main ────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const { inputFile, runId, runFolder } = parseArgs();

  if (!fs.existsSync(inputFile)) {
    console.error(`Error: Input file not found: ${inputFile}`);
    process.exit(1);
  }

  const result = await runStep(
    { stepNumber: STEP_NUMBER, stepName: STEP_NAMES[STEP_NUMBER], runId, runFolder },
    async () => {
      const dataDir = getDataDir(runFolder);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const outputPath = path.join(dataDir, OUTPUT_FILE);

      console.log(`\n[enrich] Reading: ${inputFile}`);
      const companies: ShortlistCompany[] = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
      console.log(`[enrich] Enriching ${companies.length} companies via Apollo.io...`);

      const enriched: EnrichedCompany[] = [];
      let found = 0;
      let noPerson = 0;
      let errors = 0;

      for (let i = 0; i < companies.length; i++) {
        const company = companies[i];
        process.stdout.write(`  [${i + 1}/${companies.length}] ${company.domain} ... `);

        const enrichedCompany = await enrichCompany(company);
        enriched.push(enrichedCompany);

        if (enrichedCompany.enrich_status === 'found') {
          found++;
          const email = enrichedCompany.ceo_email ? ` (${enrichedCompany.ceo_email})` : ' (no email)';
          console.log(`found${email}`);
        } else if (enrichedCompany.enrich_status === 'no_person') {
          noPerson++;
          console.log('no person found');
        } else {
          errors++;
          console.log('error');
        }

        // Rate limit delay between companies
        if (i < companies.length - 1) {
          await sleep(API_DELAY_MS);
        }

        // Write incrementally every 10 companies to avoid losing progress
        if ((i + 1) % 10 === 0) {
          fs.writeFileSync(outputPath, JSON.stringify(enriched, null, 2));
        }
      }

      fs.writeFileSync(outputPath, JSON.stringify(enriched, null, 2));

      console.log(`\n[enrich] Results:`);
      console.log(`  Found with data: ${found}`);
      console.log(`  No person found: ${noPerson}`);
      console.log(`  Errors:          ${errors}`);
      console.log(`[enrich] Done. Written to ${outputPath}`);

      const warnings: string[] = [];
      if (noPerson > 0) warnings.push(`${noPerson} companies had no CEO/founder match`);
      if (errors > 0) warnings.push(`${errors} API errors`);

      const output: StepOutput = {
        summary: `Enriched ${companies.length} companies: ${found} found, ${noPerson} no match, ${errors} errors`,
        inputCount: companies.length,
        outputCount: enriched.length,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
      return { data: enriched, output };
    },
  );

  if (!result.success) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[enrich] Fatal error:', err);
  process.exit(1);
});
