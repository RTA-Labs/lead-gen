#!/usr/bin/env npx tsx
/**
 * verify.ts — Step 11: Norbert email verification.
 *
 * Verifies CEO email addresses using the Voila Norbert API.
 * Passes through companies with no email unchanged.
 *
 * Usage:
 *   verify.ts --input 10-with-emails.json
 *   verify.ts --input 10-with-emails.json --run-id 42
 *
 * Output: <dataDir>/11-verified.json
 */

import fs from 'fs';
import path from 'path';
import { verifyEmailNorbert } from './utils/api-clients.js';
import { runStep, parseRunId, parseRunFolder, getDataDir, STEP_NAMES, type StepOutput } from './utils/step-runner.js';
import { readCompanies } from './utils/io.js';

const STEP_NUMBER = 11;
const DEFAULT_INPUT = '10-with-emails.json';
const OUTPUT_FILE = '11-verified.json';

// Delay between Norbert API calls
const API_DELAY_MS = 300;

interface CompanyWithEmail {
  name: string;
  domain: string;
  ceo_email?: string;
  [key: string]: unknown;
}

interface VerifiedCompany extends CompanyWithEmail {
  email_verified?: boolean;
  email_confidence?: number;
  email_result?: string;
  verified_at?: string;
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

/* ── Verification helpers ────────────────────────────────────────── */

/**
 * Interpret Norbert result string as a boolean verified flag and numeric confidence.
 */
function interpretNorbertResult(result: string, score: number): { verified: boolean; confidence: number } {
  // Norbert result values: 'valid', 'invalid', 'accept_all', 'unknown', 'disposable', 'catch_all'
  const verified = result === 'valid' || result === 'accept_all';
  // Clamp score to 0-100
  const confidence = Math.max(0, Math.min(100, Math.round(score)));
  return { verified, confidence };
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

      console.log(`\n[verify] Reading: ${inputFile}`);
      const { companies } = readCompanies<CompanyWithEmail>(inputFile);

      const withEmails = companies.filter(c => c.ceo_email);
      const withoutEmails = companies.filter(c => !c.ceo_email);

      console.log(`[verify] ${companies.length} total companies`);
      console.log(`  With emails to verify: ${withEmails.length}`);
      console.log(`  Without email (pass-through): ${withoutEmails.length}`);

      const results: VerifiedCompany[] = [];
      let verifiedCount = 0;
      let invalidCount = 0;
      let unknownCount = 0;
      let errorCount = 0;

      for (let i = 0; i < companies.length; i++) {
        const company = companies[i];

        if (!company.ceo_email) {
          results.push({ ...company, email_verified: false, email_confidence: 0 });
          continue;
        }

        process.stdout.write(`  [${i + 1}/${companies.length}] ${company.ceo_email} ... `);

        try {
          const norbertResult = await verifyEmailNorbert(company.ceo_email);
          const { verified, confidence } = interpretNorbertResult(norbertResult.result, norbertResult.score);

          const verifiedCompany: VerifiedCompany = {
            ...company,
            email_verified: verified,
            email_confidence: confidence,
            email_result: norbertResult.result,
            verified_at: new Date().toISOString(),
          };

          results.push(verifiedCompany);

          if (verified) {
            verifiedCount++;
            console.log(`${norbertResult.result} (${confidence}%)`);
          } else if (norbertResult.result === 'invalid') {
            invalidCount++;
            console.log(`invalid`);
          } else {
            unknownCount++;
            console.log(`${norbertResult.result}`);
          }

          // Rate limit
          if (i < companies.length - 1) {
            await sleep(API_DELAY_MS);
          }
        } catch (err) {
          console.error(`error: ${err instanceof Error ? err.message : err}`);
          errorCount++;
          results.push({ ...company, email_verified: false, email_confidence: 0, email_result: 'error' });
        }

        // Write incrementally every 10 companies
        if ((i + 1) % 10 === 0) {
          fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
        }
      }

      fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

      console.log(`\n[verify] Results:`);
      console.log(`  Verified (deliverable):  ${verifiedCount}`);
      console.log(`  Invalid:                 ${invalidCount}`);
      console.log(`  Unknown/catch-all:       ${unknownCount}`);
      console.log(`  Errors:                  ${errorCount}`);
      console.log(`  No email (pass-through): ${withoutEmails.length}`);
      console.log(`[verify] Done. Written to ${outputPath}`);

      const warnings: string[] = [];
      if (invalidCount > 0) warnings.push(`${invalidCount} emails invalid`);
      if (errorCount > 0) warnings.push(`${errorCount} verification errors`);

      const output: StepOutput = {
        summary: `Verified ${withEmails.length} emails: ${verifiedCount} deliverable, ${invalidCount} invalid`,
        inputCount: companies.length,
        outputCount: results.length,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
      return { data: results, output };
    },
  );

  if (!result.success) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[verify] Fatal error:', err);
  process.exit(1);
});
