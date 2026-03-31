#!/usr/bin/env npx tsx
/**
 * evaluate.ts — Step 13: Post-pipeline quality check.
 *
 * Runs 5 evaluation phases:
 *   Phase 1: Filter compliance  — checks each company against filters.md rules
 *   Phase 2: KB vector evaluation — scores against knowledge base (if kb.db exists)
 *   Phase 3: Thesis evaluation — placeholder for agent-driven thesis check (--skip-thesis to skip)
 *   Phase 4: Recommendations — generates actionable recommendations
 *   Phase 5: Grading — composite score mapped to A-F letter grade
 *
 * Usage:
 *   evaluate.ts --input 11-verified.json
 *   evaluate.ts --input 11-verified.json --skip-thesis
 *   evaluate.ts --input 11-verified.json --kb-threshold 0.40
 *   evaluate.ts --input 11-verified.json --run-id 42
 *
 * Output: <dataDir>/13-evaluation.json
 */

import fs from 'fs';
import path from 'path';
import { PATHS } from './utils/paths.js';
import { loadFilters, isExcludedUrl, type Filters } from './utils/filters.js';
import { runStep, parseRunId, parseRunFolder, getDataDir, STEP_NAMES, type StepOutput } from './utils/step-runner.js';
import { getKbDb, queryKNN, getKbStats, closeKbDb, type KbNeighbor } from './utils/kb-db.js';
import { embedBatch, ensureEmbedModel, composeEmbedText, vectorToBuffer, getEmbedProvider } from './utils/embeddings.js';

const STEP_NUMBER = 13;
const DEFAULT_INPUT = '11-verified.json';
const OUTPUT_FILE = '13-evaluation.json';

const KNN_K = 10;
const DEFAULT_KB_THRESHOLD = 0.40;

interface VerifiedCompany {
  name: string;
  domain: string;
  website?: string;
  description?: string;
  city?: string;
  industry?: string;
  match_type?: string;
  employee_count?: number;
  ceo_email?: string;
  email_verified?: boolean;
  email_confidence?: number;
  hooks?: string;
  thesis_score?: number;
  score?: number;
  [key: string]: unknown;
}

interface FilterFlag {
  rule: string;
  detail: string;
}

interface KbEvalResult {
  nearest_good_distance?: number;
  nearest_bad_distance?: number;
  good_neighbors: number;
  bad_neighbors: number;
  kb_score?: number; // 0-100, higher = more similar to good leads
  kb_verdict?: 'strong' | 'likely' | 'weak' | 'risky' | 'unknown';
}

interface CompanyEvaluation {
  domain: string;
  name: string;
  match_type?: string;
  filter_flags: FilterFlag[];
  filter_pass: boolean;
  kb?: KbEvalResult;
  thesis_evaluated: boolean;
  overall_verdict: 'pass' | 'review' | 'fail';
  composite_score: number;
  grade: string;
}

interface Recommendation {
  category: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
}

interface EvaluationReport {
  evaluated_at: string;
  total: number;
  // Phase 1
  filter_pass: number;
  filter_fail: number;
  // Phase 2
  kb_evaluated: boolean;
  kb_stats?: { total: number; good: number; bad: number };
  // Phase 3
  thesis_evaluated: boolean;
  // Phase 4
  recommendations: Recommendation[];
  // Phase 5
  grade_summary: Record<string, number>;
  overall_grade: string;
  overall_score: number;
  // Per-company
  results: CompanyEvaluation[];
}

/* ── CLI arg parsing ─────────────────────────────────────────────── */

function parseArgs(): { inputFile: string; skipThesis: boolean; kbThreshold: number; runId?: number; runFolder?: string } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const runId = parseRunId(args);
  const runFolder = parseRunFolder(args);
  const skipThesis = args.includes('--skip-thesis');
  const kbThresholdArg = get('--kb-threshold');
  const kbThreshold = kbThresholdArg ? parseFloat(kbThresholdArg) : DEFAULT_KB_THRESHOLD;

  let inputFile = get('--input') ?? DEFAULT_INPUT;
  if (!path.isAbsolute(inputFile)) {
    inputFile = path.join(getDataDir(runFolder), inputFile);
  }

  return { inputFile, skipThesis, kbThreshold, runId, runFolder };
}

/* ── Phase 1: Filter compliance ──────────────────────────────────── */

function checkFilterCompliance(
  company: VerifiedCompany,
  filters: Filters,
): FilterFlag[] {
  const flags: FilterFlag[] = [];

  // Domain exclusion check
  if (isExcludedUrl(company.domain, filters)) {
    flags.push({ rule: 'excluded_domain', detail: `Domain ${company.domain} is in the exclusion list` });
  }

  // Website URL exclusion check
  if (company.website && isExcludedUrl(company.website, filters)) {
    flags.push({ rule: 'excluded_url', detail: `Website URL matches exclusion filter` });
  }

  // Basic validity checks
  if (!company.name || company.name.trim().length < 2) {
    flags.push({ rule: 'invalid_name', detail: 'Company name is missing or too short' });
  }

  if (!company.domain || !company.domain.includes('.')) {
    flags.push({ rule: 'invalid_domain', detail: 'Domain is missing or malformed' });
  }

  // Employee count sanity check
  if (company.employee_count !== undefined && company.employee_count < 1) {
    flags.push({ rule: 'invalid_employee_count', detail: `Employee count is ${company.employee_count}` });
  }

  // match_type validation
  if (company.match_type) {
    const validTypes = ['definite_target', 'likely_target', 'possible_target'];
    if (!validTypes.includes(company.match_type)) {
      flags.push({
        rule: 'invalid_match_type',
        detail: `match_type "${company.match_type}" is not a valid lead-gen match type`,
      });
    }
  }

  return flags;
}

/* ── Phase 2: KB vector evaluation ───────────────────────────────── */

function computeKbScore(goodNeighbors: number, badNeighbors: number, k: number): number {
  if (k === 0) return 50;
  const goodRatio = goodNeighbors / k;
  const badRatio = badNeighbors / k;
  return Math.max(0, Math.min(100, Math.round((goodRatio - badRatio * 0.5 + 0.5) * 100)));
}

function verdictFromKbScore(score: number): KbEvalResult['kb_verdict'] {
  if (score >= 75) return 'strong';
  if (score >= 55) return 'likely';
  if (score >= 40) return 'weak';
  if (score < 30) return 'risky';
  return 'unknown';
}

async function evaluateCompanyKb(
  company: VerifiedCompany,
  kbThreshold: number,
): Promise<KbEvalResult> {
  const embedText = composeEmbedText({
    company_name: company.name,
    description: company.description,
    email_domain: company.domain,
  });

  let vectors: number[][];
  try {
    vectors = await embedBatch([embedText]);
  } catch {
    return { good_neighbors: 0, bad_neighbors: 0, kb_verdict: 'unknown' };
  }

  const vectorBuffer = vectorToBuffer(vectors[0]);
  const neighbors = queryKNN(vectorBuffer, KNN_K);

  let goodNeighbors = 0;
  let badNeighbors = 0;
  let nearestGoodDist: number | undefined;
  let nearestBadDist: number | undefined;

  for (const neighbor of neighbors) {
    if (neighbor.distance > kbThreshold) continue; // skip distant neighbors

    if (neighbor.classification === 'good') {
      goodNeighbors++;
      if (nearestGoodDist === undefined || neighbor.distance < nearestGoodDist) {
        nearestGoodDist = neighbor.distance;
      }
    } else if (neighbor.classification === 'bad') {
      badNeighbors++;
      if (nearestBadDist === undefined || neighbor.distance < nearestBadDist) {
        nearestBadDist = neighbor.distance;
      }
    }
  }

  const kbScore = computeKbScore(goodNeighbors, badNeighbors, neighbors.length);

  return {
    nearest_good_distance: nearestGoodDist,
    nearest_bad_distance: nearestBadDist,
    good_neighbors: goodNeighbors,
    bad_neighbors: badNeighbors,
    kb_score: kbScore,
    kb_verdict: verdictFromKbScore(kbScore),
  };
}

/* ── Phase 4: Recommendations ────────────────────────────────────── */

function generateRecommendations(
  companies: VerifiedCompany[],
  evalResults: CompanyEvaluation[],
  kbEvaluated: boolean,
): Recommendation[] {
  const recommendations: Recommendation[] = [];

  // Check email coverage
  const withEmail = companies.filter(c => c.ceo_email).length;
  const emailRate = companies.length > 0 ? withEmail / companies.length : 0;
  if (emailRate < 0.5) {
    recommendations.push({
      category: 'data_quality',
      message: `Only ${Math.round(emailRate * 100)}% of companies have CEO emails. Consider enriching more or using alternative contact methods.`,
      severity: 'warning',
    });
  }

  // Check email verification rate
  const verified = companies.filter(c => c.email_verified).length;
  const verifyRate = withEmail > 0 ? verified / withEmail : 0;
  if (withEmail > 0 && verifyRate < 0.5) {
    recommendations.push({
      category: 'data_quality',
      message: `Only ${Math.round(verifyRate * 100)}% of emails are verified. High bounce risk.`,
      severity: 'warning',
    });
  }

  // Check filter compliance
  const filterFails = evalResults.filter(r => !r.filter_pass).length;
  if (filterFails > 0) {
    recommendations.push({
      category: 'filter_compliance',
      message: `${filterFails} companies failed filter checks. Review and remove or update filters.`,
      severity: filterFails > companies.length * 0.2 ? 'critical' : 'warning',
    });
  }

  // Check match_type coverage
  const unscored = companies.filter(c => !c.match_type).length;
  if (unscored > 0 && unscored === companies.length) {
    recommendations.push({
      category: 'scoring',
      message: `No companies have match_type set. Consider running the scoring step.`,
      severity: 'info',
    });
  }

  // KB recommendation
  if (!kbEvaluated) {
    const kbPath = PATHS.kbDatabase;
    if (!fs.existsSync(kbPath)) {
      recommendations.push({
        category: 'knowledge_base',
        message: `No knowledge base found. Import historical leads for better quality scoring.`,
        severity: 'info',
      });
    }
  } else {
    const risky = evalResults.filter(r => r.kb?.kb_verdict === 'risky').length;
    if (risky > 0) {
      recommendations.push({
        category: 'knowledge_base',
        message: `${risky} companies scored as "risky" by KB. Review these before outreach.`,
        severity: 'warning',
      });
    }
  }

  // Hooks coverage
  const withHooks = companies.filter(c => {
    if (!c.hooks) return false;
    try {
      const h = JSON.parse(c.hooks as string);
      return (h.case_studies?.length ?? 0) + (h.testimonials?.length ?? 0) +
        (h.notable_customers?.length ?? 0) + (h.recent_news?.length ?? 0) > 0;
    } catch { return false; }
  }).length;
  if (companies.length > 0 && withHooks / companies.length < 0.3) {
    recommendations.push({
      category: 'hooks',
      message: `Only ${Math.round(withHooks / companies.length * 100)}% of companies have conversation hooks. Emails may lack personalization.`,
      severity: 'info',
    });
  }

  return recommendations;
}

/* ── Phase 5: Grading ────────────────────────────────────────────── */

function computeCompositeScore(
  company: VerifiedCompany,
  filterPass: boolean,
  kbResult?: KbEvalResult,
): number {
  let score = 50; // baseline

  // Filter compliance: -30 if fail
  if (!filterPass) score -= 30;

  // match_type bonus
  if (company.match_type === 'definite_target') score += 20;
  else if (company.match_type === 'likely_target') score += 10;
  else if (company.match_type === 'possible_target') score += 5;

  // Email bonus
  if (company.ceo_email) score += 10;
  if (company.email_verified) score += 5;

  // KB score (if available)
  if (kbResult?.kb_score !== undefined) {
    // Map kb_score (0-100) to -10..+15 contribution
    score += Math.round((kbResult.kb_score - 50) * 0.3);
  }

  // Hooks bonus
  if (company.hooks) {
    try {
      const h = JSON.parse(company.hooks as string);
      const hookCount = (h.case_studies?.length ?? 0) + (h.testimonials?.length ?? 0) +
        (h.notable_customers?.length ?? 0) + (h.recent_news?.length ?? 0);
      if (hookCount > 0) score += Math.min(hookCount * 2, 10);
    } catch { /* ignore */ }
  }

  return Math.max(0, Math.min(100, score));
}

function scoreToGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 65) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

function overallVerdict(
  filterPass: boolean,
  kbResult?: KbEvalResult,
): CompanyEvaluation['overall_verdict'] {
  if (!filterPass) return 'fail';
  if (!kbResult) return 'pass';

  if (kbResult.kb_verdict === 'strong' || kbResult.kb_verdict === 'likely') return 'pass';
  if (kbResult.kb_verdict === 'risky') return 'review';
  if (kbResult.kb_verdict === 'weak') return 'review';
  return 'pass';
}

/* ── Main ────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const { inputFile, skipThesis, kbThreshold, runId, runFolder } = parseArgs();

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

      console.log(`\n[evaluate] Reading: ${inputFile}`);
      const companies: VerifiedCompany[] = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
      console.log(`[evaluate] Evaluating ${companies.length} companies`);

      // ── Phase 1: Filter compliance ──
      console.log(`\n[evaluate] Phase 1: Filter compliance`);
      const filters = loadFilters();

      let filterPassCount = 0;
      let filterFailCount = 0;
      const filterResults: Array<{ flags: FilterFlag[]; pass: boolean }> = [];

      for (const company of companies) {
        const flags = checkFilterCompliance(company, filters);
        const pass = flags.length === 0;
        filterResults.push({ flags, pass });
        if (pass) filterPassCount++;
        else filterFailCount++;
      }

      console.log(`  Filter pass: ${filterPassCount} / ${companies.length}`);
      if (filterFailCount > 0) {
        console.log(`  Filter fail: ${filterFailCount}`);
      }

      // ── Phase 2: KB vector evaluation ──
      let kbEvaluated = false;
      let kbStats: { total: number; good: number; bad: number } | undefined;
      const kbResults: Array<KbEvalResult | undefined> = new Array(companies.length).fill(undefined);

      const kbPath = PATHS.kbDatabase;
      if (fs.existsSync(kbPath)) {
        console.log(`\n[evaluate] Phase 2: KB vector evaluation (threshold: ${kbThreshold})`);
        try {
          await ensureEmbedModel();
          const stats = getKbStats();
          kbStats = { total: stats.total, good: stats.good, bad: stats.bad };
          console.log(`  KB: ${stats.total} entries (${stats.good} good, ${stats.bad} bad, ${stats.embedded} embedded)`);

          if (stats.embedded === 0) {
            console.warn(`  WARNING: KB has no embeddings. Run kb-import first. Skipping KB eval.`);
          } else {
            kbEvaluated = true;

            for (let i = 0; i < companies.length; i++) {
              try {
                kbResults[i] = await evaluateCompanyKb(companies[i], kbThreshold);
              } catch {
                // Non-fatal: skip KB eval for this company
              }

              if ((i + 1) % 10 === 0) {
                console.log(`  KB-evaluated ${i + 1}/${companies.length}...`);
              }
            }
          }

          closeKbDb();
        } catch (err) {
          console.warn(`  WARNING: Could not load KB:`, err instanceof Error ? err.message : err);
        }
      } else {
        console.log(`\n[evaluate] Phase 2: KB vector evaluation — SKIPPED (no kb.db)`);
      }

      // ── Phase 3: Thesis evaluation ──
      const thesisEvaluated = !skipThesis;
      if (skipThesis) {
        console.log(`\n[evaluate] Phase 3: Thesis evaluation — SKIPPED (use without --skip-thesis to enable)`);
      } else {
        console.log(`\n[evaluate] Phase 3: Thesis evaluation — placeholder (agent-driven)`);
        // Thesis evaluation is handled by the agent, not this script.
        // This phase is a placeholder that signals the agent should evaluate.
      }

      // ── Build per-company evaluations ──
      const evalResults: CompanyEvaluation[] = [];

      for (let i = 0; i < companies.length; i++) {
        const company = companies[i];
        const { flags, pass } = filterResults[i];
        const kbResult = kbResults[i];

        const verdict = overallVerdict(pass, kbResult);
        const compositeScore = computeCompositeScore(company, pass, kbResult);
        const grade = scoreToGrade(compositeScore);

        evalResults.push({
          domain: company.domain,
          name: company.name,
          match_type: company.match_type,
          filter_flags: flags,
          filter_pass: pass,
          kb: kbResult,
          thesis_evaluated: thesisEvaluated,
          overall_verdict: verdict,
          composite_score: compositeScore,
          grade,
        });
      }

      // ── Phase 4: Recommendations ──
      console.log(`\n[evaluate] Phase 4: Recommendations`);
      const recommendations = generateRecommendations(companies, evalResults, kbEvaluated);
      for (const rec of recommendations) {
        const icon = rec.severity === 'critical' ? 'CRITICAL' : rec.severity === 'warning' ? 'WARNING' : 'INFO';
        console.log(`  [${icon}] ${rec.category}: ${rec.message}`);
      }

      // ── Phase 5: Grading ──
      console.log(`\n[evaluate] Phase 5: Grading`);
      const gradeSummary: Record<string, number> = {};
      let totalScore = 0;

      for (const r of evalResults) {
        gradeSummary[r.grade] = (gradeSummary[r.grade] ?? 0) + 1;
        totalScore += r.composite_score;
      }

      const overallScore = companies.length > 0 ? Math.round(totalScore / companies.length) : 0;
      const overallGrade = scoreToGrade(overallScore);

      console.log(`  Grade distribution:`);
      for (const grade of ['A', 'B', 'C', 'D', 'F']) {
        if (gradeSummary[grade]) {
          console.log(`    ${grade}: ${gradeSummary[grade]}`);
        }
      }
      console.log(`  Overall score: ${overallScore}/100 (${overallGrade})`);

      // Verdict summary
      const verdictCounts: Record<string, number> = {};
      for (const r of evalResults) {
        verdictCounts[r.overall_verdict] = (verdictCounts[r.overall_verdict] ?? 0) + 1;
      }
      console.log(`  Verdict breakdown:`);
      for (const [v, count] of Object.entries(verdictCounts)) {
        console.log(`    ${v}: ${count}`);
      }

      // ── Write report ──
      const report: EvaluationReport = {
        evaluated_at: new Date().toISOString(),
        total: companies.length,
        filter_pass: filterPassCount,
        filter_fail: filterFailCount,
        kb_evaluated: kbEvaluated,
        kb_stats: kbStats,
        thesis_evaluated: thesisEvaluated,
        recommendations,
        grade_summary: gradeSummary,
        overall_grade: overallGrade,
        overall_score: overallScore,
        results: evalResults,
      };

      fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
      console.log(`\n[evaluate] Done. Written to ${outputPath}`);

      const output: StepOutput = {
        summary: `Evaluated ${companies.length} companies: ${overallGrade} (${overallScore}/100), ${filterPassCount} filter pass, ${filterFailCount} fail`,
        inputCount: companies.length,
        outputCount: evalResults.length,
        notes: [
          `Overall: ${overallGrade} (${overallScore}/100)`,
          ...Object.entries(verdictCounts).map(([v, n]) => `${v}: ${n}`),
          `${recommendations.length} recommendations`,
        ],
        warnings: recommendations
          .filter(r => r.severity === 'critical' || r.severity === 'warning')
          .map(r => r.message),
      };
      return { data: report, output };
    },
  );

  if (!result.success) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[evaluate] Fatal error:', err);
  process.exit(1);
});
