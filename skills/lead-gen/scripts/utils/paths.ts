import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const SKILL_NAME = 'lead-gen';

/**
 * Get the skill directory (where bundled configs/scripts live).
 */
export function getSkillDir(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, '..', '..');
}

/**
 * Get the workspace home directory.
 * Resolution order:
 * 1. LEAD_GEN_HOME env var
 * 2. Local ./.lead-gen/ in cwd (if it exists)
 * 3. ~/.lead-gen/ (default)
 */
export function getWorkspaceHome(): string {
  if (process.env.LEAD_GEN_HOME) {
    return path.resolve(process.env.LEAD_GEN_HOME);
  }

  const localWorkspace = path.join(process.cwd(), `.${SKILL_NAME}`);
  if (fs.existsSync(localWorkspace)) {
    return localWorkspace;
  }

  return path.join(os.homedir(), `.${SKILL_NAME}`);
}

export function getSkillDataDir(): string {
  return path.join(getWorkspaceHome(), 'data');
}

export function getSkillConfigDir(): string {
  return path.join(getWorkspaceHome(), 'config');
}

export function getSkillOutputDir(): string {
  return path.join(getWorkspaceHome(), 'output');
}

export function getRunsDir(): string {
  return path.join(getWorkspaceHome(), 'runs');
}

export function getRunDir(runId: string): string {
  return path.join(getRunsDir(), runId);
}

export function getRunDataDir(runId: string): string {
  return path.join(getRunDir(runId), 'data');
}

export function getRunOutputDir(runId: string): string {
  return path.join(getRunDir(runId), 'output');
}

export function getRunContextDir(runId: string): string {
  return path.join(getRunDir(runId), 'context');
}

export function ensureRunDirs(runId: string): void {
  for (const dir of [getRunDir(runId), getRunDataDir(runId), getRunOutputDir(runId), getRunContextDir(runId)]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

export function getFeedbackDir(): string {
  return path.join(getWorkspaceHome(), 'feedback');
}

export function ensureDataDir(): string {
  const dir = getSkillDataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureOutputDir(): string {
  const dir = getSkillOutputDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureConfigDir(): string {
  const dir = getSkillConfigDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getEnvPath(): string {
  return path.join(getWorkspaceHome(), '.env');
}

export function isWorkspaceInitialized(): boolean {
  return fs.existsSync(getWorkspaceHome());
}

export const PATHS = {
  get database() {
    return path.join(getSkillDataDir(), 'deals.db');
  },
  get kbDatabase() {
    return path.join(getSkillDataDir(), 'kb.db');
  },
  get thesis() {
    return path.join(getSkillConfigDir(), 'thesis.md');
  },
  get emailTemplate() {
    return path.join(getSkillConfigDir(), 'email-template.md');
  },
  get filters() {
    return path.join(getSkillConfigDir(), 'filters.md');
  },
};
