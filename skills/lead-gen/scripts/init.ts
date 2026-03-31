#!/usr/bin/env npx tsx
/**
 * Initialize lead-gen workspace directory structure.
 * Usage: npx tsx scripts/init.ts [--local] [--refresh-configs]
 *
 *   --local           Use ./.lead-gen/ instead of ~/.lead-gen/
 *   --refresh-configs Back up existing configs with timestamp, then overwrite from templates
 */
import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { getSkillDir } from './utils/paths.js';

const __filename = fileURLToPath(import.meta.url);

const args = process.argv.slice(2);
const isLocal = args.includes('--local');
const refreshConfigs = args.includes('--refresh-configs');

// 1. Determine workspace
const workspaceDir = isLocal
  ? path.join(process.cwd(), '.lead-gen')
  : path.join(os.homedir(), '.lead-gen');

console.log(`\nInitializing lead-gen workspace at: ${workspaceDir}\n`);

// 2. Create workspace directory
fs.mkdirSync(workspaceDir, { recursive: true });

// 3. Run npm install in the skill directory if node_modules is missing
const skillDir = getSkillDir();
const nodeModulesPath = path.join(skillDir, 'node_modules');
if (!fs.existsSync(nodeModulesPath)) {
  console.log('  Installing dependencies (npm install)...');
  execFileSync('npm', ['install'], { cwd: skillDir, stdio: 'inherit' });
  console.log('  Dependencies installed.');
} else {
  console.log('  Dependencies already installed.');
}

// 4. Install Playwright Chromium
console.log('\n  Installing Playwright Chromium...');
try {
  execFileSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit' });
  console.log('  Playwright Chromium installed.');
} catch (err) {
  console.warn('  Warning: Playwright Chromium installation failed. Web scraping may not work.');
  console.warn('  You can retry manually: npx playwright install chromium');
}

// 5. Copy config templates from skill's config/ dir to workspace config/
const configSrc = path.join(skillDir, 'config');
const configDest = path.join(workspaceDir, 'config');
fs.mkdirSync(configDest, { recursive: true });

if (fs.existsSync(configSrc)) {
  for (const file of fs.readdirSync(configSrc)) {
    const src = path.join(configSrc, file);
    const dest = path.join(configDest, file);

    if (!fs.statSync(src).isFile()) continue;

    if (fs.existsSync(dest)) {
      if (refreshConfigs) {
        const now = new Date();
        const timestamp = [
          now.getFullYear(),
          String(now.getMonth() + 1).padStart(2, '0'),
          String(now.getDate()).padStart(2, '0'),
        ].join('-') + '-' + [
          String(now.getHours()).padStart(2, '0'),
          String(now.getMinutes()).padStart(2, '0'),
          String(now.getSeconds()).padStart(2, '0'),
        ].join('');
        const bakPath = path.join(configDest, `${file}.${timestamp}.bak`);
        fs.copyFileSync(dest, bakPath);
        console.log(`  Backed up: config/${file} -> ${file}.${timestamp}.bak`);
        fs.copyFileSync(src, dest);
        console.log(`  Refreshed: config/${file}`);
      } else {
        console.log(`  Skipped (exists): config/${file}`);
      }
    } else {
      fs.copyFileSync(src, dest);
      console.log(`  Copied: config/${file}`);
    }
  }
} else {
  console.warn(`  Warning: config template directory not found at ${configSrc}`);
}

// 6. Create .env template with placeholder keys
const envPath = path.join(workspaceDir, '.env');
if (!fs.existsSync(envPath)) {
  const envTemplate = [
    '# lead-gen Configuration',
    '# Required API keys:',
    'APOLLO_API_KEY=',
    'NORBERT_API_KEY=',
    '',
    '# Required for KB embeddings via OpenAI:',
    'OPENAI_API_KEY=',
    '',
    '# Optional: override embedding provider (default: openai)',
    '# LEAD_GEN_EMBED_PROVIDER=ollama',
    '# LEAD_GEN_OLLAMA_URL=http://localhost:11434',
    '',
    '# Optional: override workspace location',
    '# LEAD_GEN_HOME=',
    '',
  ].join('\n');
  fs.writeFileSync(envPath, envTemplate);
  console.log('  Created: .env');
} else {
  console.log('  Skipped (exists): .env');
}

// 7. Create data/, output/, runs/, feedback/ directories
for (const dir of ['data', 'output', 'runs', 'feedback']) {
  const dirPath = path.join(workspaceDir, dir);
  fs.mkdirSync(dirPath, { recursive: true });
  console.log(`  Ensured: ${dir}/`);
}

// 8. Print status summary
console.log('\n--- Status Summary ---');
console.log(`  Workspace:      ${workspaceDir}`);
console.log(`  Config dir:     ${configDest}`);
console.log(`  .env:           ${envPath}`);
console.log(`  node_modules:   ${path.join(skillDir, 'node_modules')}`);

const configFiles = ['thesis.md', 'email-template.md', 'filters.md'];
for (const f of configFiles) {
  const p = path.join(configDest, f);
  console.log(`  config/${f}: ${fs.existsSync(p) ? 'present' : 'MISSING'}`);
}

// Check Playwright
let playwrightOk = false;
try {
  const { chromium } = await import('playwright');
  const executablePath = chromium.executablePath();
  playwrightOk = fs.existsSync(executablePath);
} catch {
  // not available
}
console.log(`  Playwright Chromium: ${playwrightOk ? 'installed' : 'not found'}`);

const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
for (const key of ['APOLLO_API_KEY', 'NORBERT_API_KEY', 'OPENAI_API_KEY']) {
  const match = envContent.match(new RegExp(`^${key}=(.+)$`, 'm'));
  const status = match && match[1].trim() ? 'set' : 'NOT set';
  console.log(`  ${key}: ${status}`);
}

console.log('\nDone. Edit .env to add your API keys before running the pipeline.\n');
