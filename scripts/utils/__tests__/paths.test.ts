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

describe('paths', async () => {
  const {
    getWorkspaceHome,
    getSkillDataDir,
    getSkillOutputDir,
    getRunsDir,
    getRunDir,
    getRunDataDir,
    getRunOutputDir,
    getRunContextDir,
    ensureRunDirs,
  } = await import('../paths.js');

  describe('getWorkspaceHome', () => {
    it('respects LEAD_GEN_HOME env var', () => {
      expect(getWorkspaceHome()).toBe(tmpDir);
    });
  });

  describe('getRunDir', () => {
    it('returns <home>/runs/<runId>', () => {
      expect(getRunDir('my-run')).toBe(path.join(tmpDir, 'runs', 'my-run'));
    });
  });

  describe('getRunDataDir', () => {
    it('returns <home>/runs/<runId>/data', () => {
      expect(getRunDataDir('my-run')).toBe(path.join(tmpDir, 'runs', 'my-run', 'data'));
    });
  });

  describe('getRunOutputDir', () => {
    it('returns <home>/runs/<runId>/output', () => {
      expect(getRunOutputDir('my-run')).toBe(path.join(tmpDir, 'runs', 'my-run', 'output'));
    });
  });

  describe('getRunContextDir', () => {
    it('returns <home>/runs/<runId>/context', () => {
      expect(getRunContextDir('my-run')).toBe(path.join(tmpDir, 'runs', 'my-run', 'context'));
    });
  });

  describe('ensureRunDirs', () => {
    it('creates all 4 directories on disk', () => {
      ensureRunDirs('test-run');

      expect(fs.existsSync(path.join(tmpDir, 'runs', 'test-run'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'runs', 'test-run', 'data'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'runs', 'test-run', 'output'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'runs', 'test-run', 'context'))).toBe(true);
    });
  });

  describe('shared dir helpers', () => {
    it('getSkillDataDir returns <home>/data', () => {
      expect(getSkillDataDir()).toBe(path.join(tmpDir, 'data'));
    });

    it('getSkillOutputDir returns <home>/output', () => {
      expect(getSkillOutputDir()).toBe(path.join(tmpDir, 'output'));
    });

    it('getRunsDir returns <home>/runs', () => {
      expect(getRunsDir()).toBe(path.join(tmpDir, 'runs'));
    });
  });
});
