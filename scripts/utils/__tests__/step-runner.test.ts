import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock db.js before importing step-runner (it has top-level import of db.js)
vi.mock('../db.js', () => ({
  getPipelineRun: vi.fn(),
  updatePipelineRunStep: vi.fn(),
  completePipelineRunStep: vi.fn(),
  failPipelineRunStep: vi.fn(),
  updatePipelineRunStatus: vi.fn(),
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-gen-test-'));
  process.env.LEAD_GEN_HOME = tmpDir;
});

afterEach(() => {
  delete process.env.LEAD_GEN_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('step-runner', async () => {
  const {
    parseRunId,
    parseRunFolder,
    getDataDir,
    checkPrerequisite,
    checkStepOutput,
    findLastCompletedStep,
    STEP_PREREQUISITES,
    STEP_OUTPUTS,
  } = await import('../step-runner.js');

  const { getSkillDataDir, getRunDataDir, ensureRunDirs } = await import('../paths.js');

  // --------------------------------------------------------------------------
  // Arg parsing
  // --------------------------------------------------------------------------
  describe('parseRunId', () => {
    it('parses --run-id 42', () => {
      expect(parseRunId(['--run-id', '42'])).toBe(42);
    });

    it('returns undefined for non-numeric value', () => {
      expect(parseRunId(['--run-id', 'abc'])).toBeUndefined();
    });

    it('returns undefined when flag is absent', () => {
      expect(parseRunId([])).toBeUndefined();
    });
  });

  describe('parseRunFolder', () => {
    it('parses --run value', () => {
      expect(parseRunFolder(['--run', 'austin-2026-03-31-120000'])).toBe('austin-2026-03-31-120000');
    });

    it('returns undefined when flag is absent', () => {
      expect(parseRunFolder([])).toBeUndefined();
    });

    it('returns undefined when --run has no value', () => {
      expect(parseRunFolder(['--run'])).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Data dir routing
  // --------------------------------------------------------------------------
  describe('getDataDir', () => {
    it('returns shared data dir when no runFolder', () => {
      expect(getDataDir()).toBe(getSkillDataDir());
    });

    it('returns run-specific data dir when runFolder provided', () => {
      expect(getDataDir('my-run')).toBe(getRunDataDir('my-run'));
    });
  });

  // --------------------------------------------------------------------------
  // Prerequisite checking
  // --------------------------------------------------------------------------
  describe('checkPrerequisite', () => {
    it('returns exists=true for step 2 (no prereqs)', () => {
      const result = checkPrerequisite(2);
      expect(result.exists).toBe(true);
    });

    it('returns exists=false when prerequisite file is missing', () => {
      // Step 3 requires 2-companies-raw.json
      fs.mkdirSync(getSkillDataDir(), { recursive: true });
      const result = checkPrerequisite(3);
      expect(result.exists).toBe(false);
    });

    it('returns exists=true after creating prerequisite file', () => {
      const dataDir = getSkillDataDir();
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, '2-companies-raw.json'), '[]');

      const result = checkPrerequisite(3);
      expect(result.exists).toBe(true);
    });

    it('checks in run-specific data dir when runFolder provided', () => {
      ensureRunDirs('my-run');
      const runDataDir = getRunDataDir('my-run');
      fs.writeFileSync(path.join(runDataDir, '2-companies-raw.json'), '[]');

      const result = checkPrerequisite(3, 'my-run');
      expect(result.exists).toBe(true);
    });

    it('checks array prereqs and falls back to second file', () => {
      // Step 4 prereqs: ['3-kb-validated.json', '3-new-companies.json']
      const dataDir = getSkillDataDir();
      fs.mkdirSync(dataDir, { recursive: true });

      // Neither exists
      expect(checkPrerequisite(4).exists).toBe(false);

      // Only second file exists → should still match
      fs.writeFileSync(path.join(dataDir, '3-new-companies.json'), '[]');
      expect(checkPrerequisite(4).exists).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Step output checking
  // --------------------------------------------------------------------------
  describe('checkStepOutput', () => {
    it('returns exists=false when output file missing', () => {
      fs.mkdirSync(getSkillDataDir(), { recursive: true });
      expect(checkStepOutput(2).exists).toBe(false);
    });

    it('returns exists=true when output file present', () => {
      const dataDir = getSkillDataDir();
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, '2-companies-raw.json'), '[]');
      expect(checkStepOutput(2).exists).toBe(true);
    });

    it('checks run-specific dir when runFolder provided', () => {
      ensureRunDirs('my-run');
      const runDataDir = getRunDataDir('my-run');
      fs.writeFileSync(path.join(runDataDir, '2-companies-raw.json'), '[]');

      expect(checkStepOutput(2, 'my-run').exists).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Resume detection
  // --------------------------------------------------------------------------
  describe('findLastCompletedStep', () => {
    it('returns 0 when no output files exist', () => {
      fs.mkdirSync(getSkillDataDir(), { recursive: true });
      expect(findLastCompletedStep()).toBe(0);
    });

    it('returns correct step after creating output files', () => {
      const dataDir = getSkillDataDir();
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, '2-companies-raw.json'), '[]');
      fs.writeFileSync(path.join(dataDir, '3-new-companies.json'), '[]');

      expect(findLastCompletedStep()).toBe(3);
    });

    it('uses run-specific dir when runFolder provided', () => {
      ensureRunDirs('my-run');
      const runDataDir = getRunDataDir('my-run');
      fs.writeFileSync(path.join(runDataDir, '2-companies-raw.json'), '[]');

      expect(findLastCompletedStep('my-run')).toBe(2);
    });

    it('skips optional steps (4, 13) without breaking', () => {
      const dataDir = getSkillDataDir();
      fs.mkdirSync(dataDir, { recursive: true });

      // Create outputs for steps 2, 3, skip 4 (optional), create 5
      fs.writeFileSync(path.join(dataDir, '2-companies-raw.json'), '[]');
      fs.writeFileSync(path.join(dataDir, '3-new-companies.json'), '[]');
      // Step 4 is optional — skip it
      fs.writeFileSync(path.join(dataDir, '5-shortlist.json'), '[]');

      expect(findLastCompletedStep()).toBe(5);
    });
  });
});
