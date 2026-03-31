/**
 * Step Runner Utility
 * Wraps step execution with run state tracking, prerequisite validation, and error handling.
 * Supports both legacy numeric run IDs (database) and new string run IDs (folder-based).
 */

import fs from 'fs';
import path from 'path';
import {
  getPipelineRun,
  updatePipelineRunStep,
  completePipelineRunStep,
  failPipelineRunStep,
  updatePipelineRunStatus,
} from './db.js';
import { getSkillDataDir, getRunDataDir } from './paths.js';
import {
  loadRun,
  saveRun,
  appendStepContext,
  updateRunStats,
  addRunIssue,
  failRun,
  type StepContext,
  type RunStats,
} from './runs.js';

export interface StepConfig {
  stepNumber: number;
  stepName: string;
  /** Legacy numeric run ID (database-backed) */
  runId?: number;
  /** New string run ID (folder-based) */
  runFolder?: string;
  prerequisiteFile?: string;
  outputFile?: string;
}

export interface StepResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface StepOutput {
  summary: string;
  inputCount: number;
  outputCount: number;
  notes?: string[];
  warnings?: string[];
  stats?: Partial<RunStats>;
}

/**
 * Map of step numbers to their prerequisite files.
 *
 * Pipeline (7 phases):
 *   Phase 1: DISCOVER — agent uses web search, passes URLs to extract.ts
 *   Phase 2: CLEAN — extract, dedupe, kb-validate
 *   Phase 3: FILTER & SCORE — kb-filter (optional), agent scores, shortlist
 *   Phase 4: ENRICH — enrich, scrape
 *   Phase 5: RANK & DRAFT — agent ranks + drafts emails
 *   Phase 6: VERIFY & EXPORT — verify, export
 *   Phase 7: QUALITY CHECK — evaluate
 */
export const STEP_PREREQUISITES: Record<number, string | string[]> = {
  2: [],                                              // Agent passes URLs via --urls
  3: '2-companies-raw.json',
  4: ['3-kb-validated.json', '3-new-companies.json'], // KB Filter: validated first, falls back
  5: ['3-kb-validated.json', '3-new-companies.json'], // Shortlist
  6: '5-shortlist.json',
  7: '6-enriched.json',
  11: '10-with-emails.json',                          // Verify
  12: '11-verified.json',                             // Export
  13: '11-verified.json',                             // Evaluate
};

export const STEP_OUTPUTS: Record<number, string> = {
  2: '2-companies-raw.json',
  3: '3-new-companies.json',
  4: '3-kb-validated.json',
  5: '5-shortlist.json',
  6: '6-enriched.json',
  7: '7-with-hooks.json',
  10: '10-with-emails.json',     // Written by agent
  11: '11-verified.json',
  12: 'export-complete',
  13: '13-evaluation.json',
};

export const STEP_NAMES: Record<number, string> = {
  2: 'Extract',
  3: 'Dedupe',
  4: 'KB Filter',
  5: 'Shortlist',
  6: 'Enrich',
  7: 'Scrape',
  10: 'Rank & Draft',
  11: 'Verify',
  12: 'Export',
  13: 'Evaluate',
};

export const OPTIONAL_STEPS: ReadonlySet<number> = new Set([4, 13]);
const PIPELINE_STEP_ORDER = [2, 3, 4, 5, 6, 7, 10, 11, 12, 13];

/**
 * Parse --run-id from command line arguments (legacy numeric)
 */
export function parseRunId(args: string[]): number | undefined {
  const runIdIndex = args.indexOf('--run-id');
  if (runIdIndex !== -1 && args[runIdIndex + 1]) {
    const runId = parseInt(args[runIdIndex + 1], 10);
    return isNaN(runId) ? undefined : runId;
  }
  return undefined;
}

/**
 * Parse --run from command line arguments (new folder-based)
 */
export function parseRunFolder(args: string[]): string | undefined {
  const runIndex = args.indexOf('--run');
  if (runIndex !== -1 && args[runIndex + 1]) {
    return args[runIndex + 1];
  }
  return undefined;
}

/**
 * Get the data directory for pipeline files.
 * Routes to run-specific data dir when runFolder is provided.
 */
export function getDataDir(runFolder?: string): string {
  if (runFolder) {
    return getRunDataDir(runFolder);
  }
  return getSkillDataDir();
}

/**
 * Check if a prerequisite file exists
 */
export function checkPrerequisite(
  stepNumber: number,
  runFolder?: string,
): { exists: boolean; path: string } {
  const prerequisite = STEP_PREREQUISITES[stepNumber];
  if (!prerequisite || (Array.isArray(prerequisite) && prerequisite.length === 0)) {
    return { exists: true, path: '' };
  }

  const files = Array.isArray(prerequisite) ? prerequisite : [prerequisite];
  const dataDir = getDataDir(runFolder);

  for (const file of files) {
    const filePath = path.join(dataDir, file);
    if (fs.existsSync(filePath)) {
      return { exists: true, path: filePath };
    }
  }

  return { exists: false, path: path.join(dataDir, files[0]) };
}

/**
 * Check if a step's output file exists (for resume detection)
 */
export function checkStepOutput(
  stepNumber: number,
  runFolder?: string,
): { exists: boolean; path: string } {
  const outputFile = STEP_OUTPUTS[stepNumber];
  if (!outputFile) {
    return { exists: false, path: '' };
  }

  const dataDir = getDataDir(runFolder);
  const filePath = path.join(dataDir, outputFile);
  return {
    exists: fs.existsSync(filePath),
    path: filePath,
  };
}

/**
 * Find the last completed step by checking which output files exist
 */
export function findLastCompletedStep(runFolder?: string): number {
  let lastCompleted = 0;

  for (const step of PIPELINE_STEP_ORDER) {
    const { exists } = checkStepOutput(step, runFolder);
    if (exists) {
      lastCompleted = step;
    } else if (!OPTIONAL_STEPS.has(step)) {
      break;
    }
  }

  return lastCompleted;
}

/**
 * Run a step with state tracking and error handling.
 * Returns StepOutput metadata along with the step's data.
 */
export async function runStep<T>(
  config: StepConfig,
  execute: () => Promise<{ data: T; output: StepOutput }>
): Promise<StepResult<T>>;

/**
 * Run a step with state tracking and error handling (legacy signature).
 */
export async function runStep<T>(
  config: StepConfig,
  execute: () => Promise<T>
): Promise<StepResult<T>>;

export async function runStep<T>(
  config: StepConfig,
  execute: () => Promise<T | { data: T; output: StepOutput }>
): Promise<StepResult<T>> {
  const { stepNumber, stepName, runId, runFolder } = config;
  const startTime = Date.now();

  // Validate prerequisite file exists
  const prerequisite = checkPrerequisite(stepNumber, runFolder);
  if (!prerequisite.exists) {
    const error = `Prerequisite file not found: ${prerequisite.path}`;
    console.error(`\n${error}`);

    if (runId) {
      failPipelineRunStep(runId, stepNumber, error);
    }
    if (runFolder) {
      addRunIssue(runFolder, `Step ${stepNumber} failed: ${error}`);
    }

    return { success: false, error };
  }

  // Update run state to "running step N"
  if (runId) {
    const run = getPipelineRun(runId);
    if (run) {
      updatePipelineRunStep(runId, stepNumber, stepName);
      console.log(`\nRun #${runId}: Starting step ${stepNumber} - ${stepName}`);
    }
  }

  if (runFolder) {
    const run = loadRun(runFolder);
    if (run) {
      run.currentStep = stepNumber;
      saveRun(run);
      console.log(`\nRun ${runFolder}: Starting step ${stepNumber} - ${stepName}`);
    }
  }

  try {
    const result = await execute();
    const duration = (Date.now() - startTime) / 1000;

    let data: T;
    let output: StepOutput | undefined;

    if (result && typeof result === 'object' && 'data' in result && 'output' in result) {
      data = (result as { data: T; output: StepOutput }).data;
      output = (result as { data: T; output: StepOutput }).output;
    } else {
      data = result as T;
    }

    if (runId) {
      completePipelineRunStep(runId, stepNumber);
    }

    // Write step context (folder-based)
    if (runFolder && output) {
      const stepContext: StepContext = {
        step: stepNumber,
        name: stepName,
        completedAt: new Date().toISOString(),
        duration,
        input: {
          file: prerequisite.path ? path.basename(prerequisite.path) : 'none',
          recordCount: output.inputCount,
        },
        output: {
          file: STEP_OUTPUTS[stepNumber] || 'none',
          recordCount: output.outputCount,
        },
        summary: output.summary,
        notes: output.notes || [],
        warnings: output.warnings || [],
      };

      appendStepContext(runFolder, stepContext);

      if (output.stats) {
        updateRunStats(runFolder, output.stats);
      }

      console.log(`\nRun ${runFolder}: Completed step ${stepNumber} - ${stepName} (${duration.toFixed(1)}s)`);
    }

    return { success: true, data };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`\nStep ${stepNumber} failed: ${errorMessage}`);

    if (runId) {
      failPipelineRunStep(runId, stepNumber, errorMessage);
    }
    if (runFolder) {
      failRun(runFolder, `Step ${stepNumber} (${stepName}): ${errorMessage}`);
    }

    return { success: false, error: errorMessage };
  }
}

/**
 * Mark a run as fully completed (legacy numeric)
 */
export function markRunCompleted(runId: number): void {
  updatePipelineRunStatus(runId, 'completed');
  console.log(`\nRun #${runId}: Pipeline completed successfully`);
}

/**
 * Get step info for display
 */
export function getStepInfo(stepNumber: number): {
  name: string;
  prerequisite?: string | string[];
  output?: string;
} {
  return {
    name: STEP_NAMES[stepNumber] || `Step ${stepNumber}`,
    prerequisite: STEP_PREREQUISITES[stepNumber],
    output: STEP_OUTPUTS[stepNumber],
  };
}

/**
 * Format step progress for display
 */
export function formatStepProgress(currentStep: number): string {
  const stepName = STEP_NAMES[currentStep] || 'Unknown';
  const stepIndex = PIPELINE_STEP_ORDER.indexOf(currentStep) + 1;
  return `Step ${stepIndex}/${PIPELINE_STEP_ORDER.length} - ${stepName}`;
}
