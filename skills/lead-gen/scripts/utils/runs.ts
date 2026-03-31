/**
 * Run Management Utility
 * Manages per-run folder isolation with context persistence for LLM resume capability.
 */

import fs from 'fs';
import path from 'path';
import {
  getWorkspaceHome,
  getRunsDir,
  getRunDir,
  getRunDataDir,
  getRunOutputDir,
  getRunContextDir,
  ensureRunDirs,
} from './paths.js';

// ============================================================================
// Types
// ============================================================================

export type RunStatus = 'active' | 'completed' | 'failed';

export interface RunStats {
  companiesFound: number;
  companiesAfterDedup: number;
  companiesShortlisted: number;
  companiesEnriched: number;
  companiesScraped: number;
  companiesVerified: number;
  companiesExported: number;
}

export interface RunContext {
  runId: string;
  city: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  currentStep: number;

  // Context for LLM resume
  summary: string;
  decisions: string[];
  issues: string[];
  stats: RunStats;
}

export interface StepContext {
  step: number;
  name: string;
  completedAt: string;
  duration: number; // seconds

  // What happened
  input: {
    file: string;
    recordCount: number;
  };
  output: {
    file: string;
    recordCount: number;
  };

  // LLM context
  summary: string;
  notes: string[];
  warnings: string[];
}

export interface RunEntry {
  runId: string;
  city: string;
  status: RunStatus;
  currentStep: number;
  createdAt: string;
  updatedAt: string;
}

export interface RunRegistry {
  activeRunId: string | null;
  runs: RunEntry[];
}

// ============================================================================
// Path Helpers (local to runs)
// ============================================================================

function getRegistryPath(): string {
  return path.join(getWorkspaceHome(), 'runs.json');
}

function getRunJsonPath(runId: string): string {
  return path.join(getRunDir(runId), 'run.json');
}

function getStepContextPath(runId: string, step: number): string {
  return path.join(getRunContextDir(runId), `step-${step}.json`);
}

// ============================================================================
// Run ID Generation
// ============================================================================

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function generateRunId(city: string): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const time = now.toTimeString().split(' ')[0].replace(/:/g, ''); // HHMMSS
  const citySlug = slugify(city);
  return `${citySlug}-${date}-${time}`;
}

// ============================================================================
// Registry Functions
// ============================================================================

export function loadRunRegistry(): RunRegistry {
  const registryPath = getRegistryPath();

  if (!fs.existsSync(registryPath)) {
    return { activeRunId: null, runs: [] };
  }

  try {
    const content = fs.readFileSync(registryPath, 'utf-8');
    return JSON.parse(content) as RunRegistry;
  } catch {
    return { activeRunId: null, runs: [] };
  }
}

function saveRunRegistry(registry: RunRegistry): void {
  const home = getWorkspaceHome();
  if (!fs.existsSync(home)) {
    fs.mkdirSync(home, { recursive: true });
  }

  const registryPath = getRegistryPath();
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

export function listRuns(): RunEntry[] {
  const registry = loadRunRegistry();
  return registry.runs;
}

// ============================================================================
// Run Lifecycle Functions
// ============================================================================

function createEmptyStats(): RunStats {
  return {
    companiesFound: 0,
    companiesAfterDedup: 0,
    companiesShortlisted: 0,
    companiesEnriched: 0,
    companiesScraped: 0,
    companiesVerified: 0,
    companiesExported: 0,
  };
}

export function createRun(city: string): RunContext {
  const runId = generateRunId(city);
  const now = new Date().toISOString();

  // Create run directories
  ensureRunDirs(runId);

  // Create run context
  const run: RunContext = {
    runId,
    city,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    currentStep: 0,
    summary: `Started lead generation pipeline for ${city}`,
    decisions: [],
    issues: [],
    stats: createEmptyStats(),
  };

  // Save run.json
  saveRun(run);

  // Update registry
  const registry = loadRunRegistry();
  registry.activeRunId = runId;
  registry.runs.push({
    runId,
    city,
    status: 'active',
    currentStep: 0,
    createdAt: now,
    updatedAt: now,
  });
  saveRunRegistry(registry);

  console.log(`\nCreated run: ${runId}`);
  console.log(`   Directory: ${getRunDir(runId)}`);

  return run;
}

export function loadRun(runId: string): RunContext | null {
  const runJsonPath = getRunJsonPath(runId);

  if (!fs.existsSync(runJsonPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(runJsonPath, 'utf-8');
    return JSON.parse(content) as RunContext;
  } catch {
    return null;
  }
}

export function saveRun(run: RunContext): void {
  run.updatedAt = new Date().toISOString();

  const runJsonPath = getRunJsonPath(run.runId);
  fs.writeFileSync(runJsonPath, JSON.stringify(run, null, 2));

  // Also update registry entry
  const registry = loadRunRegistry();
  const entryIndex = registry.runs.findIndex(r => r.runId === run.runId);
  if (entryIndex >= 0) {
    registry.runs[entryIndex] = {
      runId: run.runId,
      city: run.city,
      status: run.status,
      currentStep: run.currentStep,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
    saveRunRegistry(registry);
  }
}

export function getActiveRun(): RunContext | null {
  const registry = loadRunRegistry();

  if (!registry.activeRunId) {
    return null;
  }

  return loadRun(registry.activeRunId);
}

export function setActiveRun(runId: string | null): void {
  const registry = loadRunRegistry();
  registry.activeRunId = runId;
  saveRunRegistry(registry);
}

export function completeRun(runId: string): void {
  const run = loadRun(runId);
  if (!run) return;

  run.status = 'completed';
  run.summary = `Completed lead generation for ${run.city}. Exported ${run.stats.companiesExported} companies.`;
  saveRun(run);

  // Clear active run if this was it
  const registry = loadRunRegistry();
  if (registry.activeRunId === runId) {
    registry.activeRunId = null;
    saveRunRegistry(registry);
  }

  console.log(`\nRun ${runId} marked as completed`);
}

export function failRun(runId: string, error: string): void {
  const run = loadRun(runId);
  if (!run) return;

  run.status = 'failed';
  run.issues.push(`Fatal error: ${error}`);
  saveRun(run);

  console.log(`\nRun ${runId} marked as failed: ${error}`);
}

// ============================================================================
// Context Management
// ============================================================================

export function appendStepContext(runId: string, context: StepContext): void {
  // Ensure context directory exists
  const contextDir = getRunContextDir(runId);
  if (!fs.existsSync(contextDir)) {
    fs.mkdirSync(contextDir, { recursive: true });
  }

  // Write step context file
  const contextPath = getStepContextPath(runId, context.step);
  fs.writeFileSync(contextPath, JSON.stringify(context, null, 2));

  // Update run.json with latest step info
  const run = loadRun(runId);
  if (run) {
    run.currentStep = context.step;
    run.summary = updateSummaryWithStep(run, context);
    saveRun(run);
  }
}

export function loadStepContext(runId: string, step: number): StepContext | null {
  const contextPath = getStepContextPath(runId, step);

  if (!fs.existsSync(contextPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(contextPath, 'utf-8');
    return JSON.parse(content) as StepContext;
  } catch {
    return null;
  }
}

function updateSummaryWithStep(run: RunContext, stepContext: StepContext): string {
  const stepSummaries: string[] = [];

  // Load all completed step summaries
  for (let i = 1; i <= stepContext.step; i++) {
    const ctx = i === stepContext.step ? stepContext : loadStepContext(run.runId, i);
    if (ctx) {
      stepSummaries.push(`Step ${i} (${ctx.name}): ${ctx.summary}`);
    }
  }

  return `Lead generation pipeline for ${run.city}.\n${stepSummaries.join('\n')}`;
}

export function buildResumeContext(runId: string): string {
  const run = loadRun(runId);
  if (!run) {
    return `Run ${runId} not found.`;
  }

  const lines: string[] = [
    `Resuming run: ${run.runId}`,
    `City: ${run.city}`,
    `Status: ${run.status}`,
    `Current step: ${run.currentStep}`,
    '',
    'Run summary:',
    run.summary,
    '',
  ];

  // Add stats if any progress
  if (run.currentStep > 0) {
    lines.push('Stats:');
    if (run.stats.companiesFound > 0) {
      lines.push(`  - Companies found: ${run.stats.companiesFound}`);
    }
    if (run.stats.companiesAfterDedup > 0) {
      lines.push(`  - After dedup: ${run.stats.companiesAfterDedup}`);
    }
    if (run.stats.companiesShortlisted > 0) {
      lines.push(`  - Shortlisted: ${run.stats.companiesShortlisted}`);
    }
    if (run.stats.companiesEnriched > 0) {
      lines.push(`  - Enriched: ${run.stats.companiesEnriched}`);
    }
    if (run.stats.companiesScraped > 0) {
      lines.push(`  - Scraped: ${run.stats.companiesScraped}`);
    }
    if (run.stats.companiesVerified > 0) {
      lines.push(`  - Verified: ${run.stats.companiesVerified}`);
    }
    if (run.stats.companiesExported > 0) {
      lines.push(`  - Exported: ${run.stats.companiesExported}`);
    }
    lines.push('');
  }

  // Load last step context for details
  if (run.currentStep > 0) {
    const lastStep = loadStepContext(runId, run.currentStep);
    if (lastStep) {
      lines.push(`Last completed step (${lastStep.step} - ${lastStep.name}):`);
      lines.push(`  - Input: ${lastStep.input.recordCount} records from ${lastStep.input.file}`);
      lines.push(`  - Output: ${lastStep.output.recordCount} records to ${lastStep.output.file}`);
      lines.push(`  - Duration: ${lastStep.duration.toFixed(1)}s`);

      if (lastStep.notes.length > 0) {
        lines.push(`  - Notes: ${lastStep.notes.join('; ')}`);
      }
      if (lastStep.warnings.length > 0) {
        lines.push(`  - Warnings: ${lastStep.warnings.join('; ')}`);
      }
      lines.push('');
    }
  }

  // Add any decisions made
  if (run.decisions.length > 0) {
    lines.push('Key decisions:');
    for (const decision of run.decisions) {
      lines.push(`  - ${decision}`);
    }
    lines.push('');
  }

  // Add any issues
  if (run.issues.length > 0) {
    lines.push('Issues encountered:');
    for (const issue of run.issues) {
      lines.push(`  - ${issue}`);
    }
    lines.push('');
  }

  const nextStep = run.currentStep + 1;
  lines.push(`Ready to continue with step ${nextStep}...`);

  return lines.join('\n');
}

// ============================================================================
// Run Stats Updates
// ============================================================================

export function updateRunStats(
  runId: string,
  updates: Partial<RunStats>
): void {
  const run = loadRun(runId);
  if (!run) return;

  run.stats = { ...run.stats, ...updates };
  saveRun(run);
}

export function addRunDecision(runId: string, decision: string): void {
  const run = loadRun(runId);
  if (!run) return;

  run.decisions.push(decision);
  saveRun(run);
}

export function addRunIssue(runId: string, issue: string): void {
  const run = loadRun(runId);
  if (!run) return;

  run.issues.push(issue);
  saveRun(run);
}

// ============================================================================
// Utility: Find run by partial ID or get latest
// ============================================================================

export function findRun(query: string): RunContext | null {
  const registry = loadRunRegistry();

  // Exact match
  const exactMatch = registry.runs.find(r => r.runId === query);
  if (exactMatch) {
    return loadRun(exactMatch.runId);
  }

  // Partial match (prefix)
  const partialMatches = registry.runs.filter(r => r.runId.startsWith(query));
  if (partialMatches.length === 1) {
    return loadRun(partialMatches[0].runId);
  }

  // If query looks like a city, find latest for that city
  const cityMatches = registry.runs
    .filter(r => r.city.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (cityMatches.length > 0) {
    return loadRun(cityMatches[0].runId);
  }

  return null;
}

export function getLatestRunForCity(city: string): RunContext | null {
  const registry = loadRunRegistry();
  const citySlug = slugify(city);

  const matches = registry.runs
    .filter(r => slugify(r.city) === citySlug)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (matches.length > 0) {
    return loadRun(matches[0].runId);
  }

  return null;
}
