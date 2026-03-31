#!/usr/bin/env npx tsx
/**
 * shortlist.ts — Step 5: Takes scored company data, sorts by score descending, slices top N.
 *
 * Usage:
 *   shortlist.ts --input 3-new-companies.json --limit 20
 *   shortlist.ts --input 4-scored.json --limit 20 --run-id 42
 *
 * Output: <dataDir>/5-shortlist.json
 */

import fs from 'fs';
import path from 'path';
import { runStep, parseRunId, parseRunFolder, getDataDir, STEP_NAMES, type StepOutput } from './utils/step-runner.js';

const STEP_NUMBER = 5;
const DEFAULT_INPUT = '3-new-companies.json';
const OUTPUT_FILE = '5-shortlist.json';
const DEFAULT_LIMIT = 20;

interface ScoredCompany {
  name: string;
  domain: string;
  website?: string;
  description?: string;
  city?: string;
  source?: string;
  score?: number;
  prerank_score?: number;
  match_type?: 'definite_target' | 'likely_target' | 'possible_target';
  filter_flags?: string[];
  [key: string]: unknown;
}

/* ── CLI arg parsing ─────────────────────────────────────────────── */

function parseArgs(): { inputFile: string; limit: number; runId?: number; runFolder?: string } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const runId = parseRunId(args);
  const runFolder = parseRunFolder(args);
  const limitArg = get('--limit');
  const limit = limitArg ? parseInt(limitArg, 10) : DEFAULT_LIMIT;

  let inputFile = get('--input') ?? DEFAULT_INPUT;
  if (!path.isAbsolute(inputFile)) {
    inputFile = path.join(getDataDir(runFolder), inputFile);
  }

  return { inputFile, limit, runId, runFolder };
}

/* ── Sorting helpers ─────────────────────────────────────────────── */

function matchTypePriority(matchType?: string): number {
  switch (matchType) {
    case 'definite_target': return 3;
    case 'likely_target':   return 2;
    case 'possible_target': return 1;
    default:                return 0;
  }
}

/* ── Main ────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const { inputFile, limit, runId, runFolder } = parseArgs();

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

      console.log(`\n[shortlist] Reading: ${inputFile}`);
      const scored: ScoredCompany[] = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
      console.log(`[shortlist] Input: ${scored.length} companies, limit: ${limit}`);

      // Detect if prerank_score is present on any company
      const hasPrerankScore = scored.some(c => typeof c.prerank_score === 'number');
      const hasScore = scored.some(c => typeof c.score === 'number');

      let sorted: ScoredCompany[];

      if (hasPrerankScore || hasScore) {
        // Sort by: match_type priority desc, then score desc, then name asc
        sorted = [...scored].sort((a, b) => {
          const matchDiff = matchTypePriority(b.match_type) - matchTypePriority(a.match_type);
          if (matchDiff !== 0) return matchDiff;

          const getScore = (c: ScoredCompany) =>
            typeof c.prerank_score === 'number' ? c.prerank_score
            : typeof c.score === 'number' ? c.score
            : 0;

          const scoreDiff = getScore(b) - getScore(a);
          if (scoreDiff !== 0) return scoreDiff;

          return (a.name ?? '').localeCompare(b.name ?? '');
        });
        console.log(`[shortlist] Sorting by ${hasPrerankScore ? 'prerank_score' : 'score'} + match_type`);
      } else {
        // No score field — keep original order (agent may have already ordered them)
        sorted = [...scored];
        console.log(`[shortlist] No score fields detected — keeping original order`);
      }

      const shortlist = sorted.slice(0, limit);

      fs.writeFileSync(outputPath, JSON.stringify(shortlist, null, 2));

      // Summary by match_type
      const counts: Record<string, number> = {};
      for (const c of shortlist) {
        const mt = c.match_type ?? 'unscored';
        counts[mt] = (counts[mt] ?? 0) + 1;
      }

      console.log(`\n[shortlist] Selected top ${shortlist.length} of ${sorted.length} companies:`);
      for (const [mt, count] of Object.entries(counts)) {
        console.log(`  ${mt}: ${count}`);
      }
      console.log(`[shortlist] Done. Written to ${outputPath}`);

      const output: StepOutput = {
        summary: `Shortlisted top ${shortlist.length} of ${scored.length} companies`,
        inputCount: scored.length,
        outputCount: shortlist.length,
        notes: Object.entries(counts).map(([mt, n]) => `${mt}: ${n}`),
      };
      return { data: shortlist, output };
    },
  );

  if (!result.success) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[shortlist] Fatal error:', err);
  process.exit(1);
});
