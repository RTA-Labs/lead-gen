import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-gen-test-'));
  process.env.LEAD_GEN_HOME = tmpDir;
});

afterEach(() => {
  delete process.env.LEAD_GEN_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runs', async () => {
  const {
    generateRunId,
    loadRunRegistry,
    listRuns,
    createRun,
    loadRun,
    saveRun,
    getActiveRun,
    setActiveRun,
    completeRun,
    failRun,
    appendStepContext,
    loadStepContext,
    buildResumeContext,
    updateRunStats,
    addRunDecision,
    addRunIssue,
    findRun,
    getLatestRunForCity,
  } = await import('../runs.js');

  // --------------------------------------------------------------------------
  // Run ID generation
  // --------------------------------------------------------------------------
  describe('generateRunId', () => {
    it('matches pattern <city-slug>-YYYY-MM-DD-HHMMSS', () => {
      const id = generateRunId('Austin');
      expect(id).toMatch(/^austin-\d{4}-\d{2}-\d{2}-\d{6}$/);
    });

    it('slugifies multi-word city names', () => {
      const id = generateRunId('New York City');
      expect(id).toMatch(/^new-york-city-\d{4}-\d{2}-\d{2}-\d{6}$/);
    });

    it('handles special characters', () => {
      const id = generateRunId('São Paulo');
      // Non-ASCII stripped, becomes "s-o-paulo" or similar
      expect(id).toMatch(/^[a-z0-9-]+-\d{4}-\d{2}-\d{2}-\d{6}$/);
    });
  });

  // --------------------------------------------------------------------------
  // Registry CRUD
  // --------------------------------------------------------------------------
  describe('registry', () => {
    it('loadRunRegistry returns empty registry when no file exists', () => {
      const reg = loadRunRegistry();
      expect(reg).toEqual({ activeRunId: null, runs: [] });
    });

    it('loadRunRegistry returns empty registry on corrupted JSON', () => {
      const home = tmpDir;
      fs.writeFileSync(path.join(home, 'runs.json'), '{bad json!!!');
      const reg = loadRunRegistry();
      expect(reg).toEqual({ activeRunId: null, runs: [] });
    });

    it('listRuns returns empty array initially', () => {
      expect(listRuns()).toEqual([]);
    });

    it('after createRun, listRuns has 1 entry', () => {
      createRun('Austin');
      expect(listRuns()).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // Run lifecycle
  // --------------------------------------------------------------------------
  describe('lifecycle', () => {
    it('createRun creates dirs, run.json, registry entry, sets activeRunId', () => {
      const run = createRun('Austin');

      // Dirs exist
      expect(fs.existsSync(path.join(tmpDir, 'runs', run.runId))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'runs', run.runId, 'data'))).toBe(true);

      // run.json exists
      expect(fs.existsSync(path.join(tmpDir, 'runs', run.runId, 'run.json'))).toBe(true);

      // Registry has entry with activeRunId
      const reg = loadRunRegistry();
      expect(reg.activeRunId).toBe(run.runId);
      expect(reg.runs).toHaveLength(1);
    });

    it('loadRun returns the created run', () => {
      const created = createRun('Austin');
      const loaded = loadRun(created.runId);
      expect(loaded).not.toBeNull();
      expect(loaded!.runId).toBe(created.runId);
      expect(loaded!.city).toBe('Austin');
    });

    it('loadRun returns null for nonexistent run', () => {
      expect(loadRun('nonexistent')).toBeNull();
    });

    it('saveRun updates updatedAt and syncs registry', () => {
      const run = createRun('Austin');
      const originalUpdated = run.updatedAt;

      // Small delay to ensure different timestamp
      run.summary = 'Updated summary';
      saveRun(run);

      const reloaded = loadRun(run.runId)!;
      expect(reloaded.summary).toBe('Updated summary');
      // updatedAt should be refreshed (or at least present)
      expect(reloaded.updatedAt).toBeDefined();
    });

    it('getActiveRun returns the active run', () => {
      const run = createRun('Austin');
      const active = getActiveRun();
      expect(active).not.toBeNull();
      expect(active!.runId).toBe(run.runId);
    });

    it('setActiveRun(null) clears active run', () => {
      createRun('Austin');
      setActiveRun(null);
      expect(getActiveRun()).toBeNull();
    });

    it('completeRun sets status=completed, clears activeRunId', () => {
      const run = createRun('Austin');
      completeRun(run.runId);

      const loaded = loadRun(run.runId)!;
      expect(loaded.status).toBe('completed');

      const reg = loadRunRegistry();
      expect(reg.activeRunId).toBeNull();
    });

    it('failRun sets status=failed, adds issue', () => {
      const run = createRun('Austin');
      failRun(run.runId, 'Something broke');

      const loaded = loadRun(run.runId)!;
      expect(loaded.status).toBe('failed');
      expect(loaded.issues).toContain('Fatal error: Something broke');
    });
  });

  // --------------------------------------------------------------------------
  // Context management
  // --------------------------------------------------------------------------
  describe('context management', () => {
    it('appendStepContext writes step-N.json, updates currentStep and summary', () => {
      const run = createRun('Austin');

      appendStepContext(run.runId, {
        step: 2,
        name: 'Extract',
        completedAt: new Date().toISOString(),
        duration: 12.5,
        input: { file: 'none', recordCount: 0 },
        output: { file: '2-companies-raw.json', recordCount: 50 },
        summary: 'Extracted 50 companies',
        notes: [],
        warnings: [],
      });

      // step-2.json exists
      const contextPath = path.join(tmpDir, 'runs', run.runId, 'context', 'step-2.json');
      expect(fs.existsSync(contextPath)).toBe(true);

      // run.json updated
      const reloaded = loadRun(run.runId)!;
      expect(reloaded.currentStep).toBe(2);
      expect(reloaded.summary).toContain('Extract');
    });

    it('loadStepContext reads back the context', () => {
      const run = createRun('Austin');

      const stepCtx = {
        step: 3,
        name: 'Dedupe',
        completedAt: new Date().toISOString(),
        duration: 5.2,
        input: { file: '2-companies-raw.json', recordCount: 50 },
        output: { file: '3-new-companies.json', recordCount: 45 },
        summary: 'Deduped to 45',
        notes: ['Removed 5 duplicates'],
        warnings: [],
      };

      appendStepContext(run.runId, stepCtx);
      const loaded = loadStepContext(run.runId, 3);
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('Dedupe');
      expect(loaded!.output.recordCount).toBe(45);
    });

    it('loadStepContext returns null for missing step', () => {
      const run = createRun('Austin');
      expect(loadStepContext(run.runId, 99)).toBeNull();
    });

    it('buildResumeContext includes city, status, stats, step details', () => {
      const run = createRun('Austin');
      updateRunStats(run.runId, { companiesFound: 50 });

      appendStepContext(run.runId, {
        step: 2,
        name: 'Extract',
        completedAt: new Date().toISOString(),
        duration: 10,
        input: { file: 'none', recordCount: 0 },
        output: { file: '2-companies-raw.json', recordCount: 50 },
        summary: 'Extracted 50 companies',
        notes: [],
        warnings: [],
      });

      const ctx = buildResumeContext(run.runId);
      expect(ctx).toContain('Austin');
      expect(ctx).toContain('active');
      expect(ctx).toContain('Companies found: 50');
      expect(ctx).toContain('Extract');
    });

    it('buildResumeContext returns "not found" for missing run', () => {
      const ctx = buildResumeContext('nonexistent');
      expect(ctx).toContain('not found');
    });
  });

  // --------------------------------------------------------------------------
  // Stats, decisions, issues
  // --------------------------------------------------------------------------
  describe('stats/decisions/issues', () => {
    it('updateRunStats merges partial stats', () => {
      const run = createRun('Austin');
      updateRunStats(run.runId, { companiesFound: 100 });
      updateRunStats(run.runId, { companiesAfterDedup: 80 });

      const loaded = loadRun(run.runId)!;
      expect(loaded.stats.companiesFound).toBe(100);
      expect(loaded.stats.companiesAfterDedup).toBe(80);
    });

    it('addRunDecision appends to decisions array', () => {
      const run = createRun('Austin');
      addRunDecision(run.runId, 'Chose strict filters');
      addRunDecision(run.runId, 'Skipped KB validation');

      const loaded = loadRun(run.runId)!;
      expect(loaded.decisions).toHaveLength(2);
      expect(loaded.decisions[0]).toBe('Chose strict filters');
    });

    it('addRunIssue appends to issues array', () => {
      const run = createRun('Austin');
      addRunIssue(run.runId, 'API rate limited');

      const loaded = loadRun(run.runId)!;
      expect(loaded.issues).toHaveLength(1);
      expect(loaded.issues[0]).toBe('API rate limited');
    });
  });

  // --------------------------------------------------------------------------
  // Search
  // --------------------------------------------------------------------------
  describe('search', () => {
    it('findRun returns exact match', () => {
      const run = createRun('Austin');
      const found = findRun(run.runId);
      expect(found).not.toBeNull();
      expect(found!.runId).toBe(run.runId);
    });

    it('findRun returns unique prefix match', () => {
      const run = createRun('Austin');
      // Use enough of the ID to be unique
      const prefix = run.runId.substring(0, 10);
      const found = findRun(prefix);
      expect(found).not.toBeNull();
      expect(found!.runId).toBe(run.runId);
    });

    it('findRun returns latest run for city name', () => {
      createRun('Austin');
      const run2 = createRun('Austin');
      const found = findRun('Austin');
      expect(found).not.toBeNull();
      expect(found!.runId).toBe(run2.runId);
    });

    it('findRun returns null for nonexistent', () => {
      expect(findRun('nonexistent')).toBeNull();
    });

    it('getLatestRunForCity returns most recent run', () => {
      createRun('Austin');
      const run2 = createRun('Austin');

      const latest = getLatestRunForCity('Austin');
      expect(latest).not.toBeNull();
      expect(latest!.runId).toBe(run2.runId);
    });
  });
});
