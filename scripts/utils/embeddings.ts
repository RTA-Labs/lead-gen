import * as readline from 'readline';
import os from 'os';
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
import OpenAI from 'openai';
import { getWorkspaceHome } from './paths.js';

// Load .env from workspace home
dotenvConfig({ path: path.join(getWorkspaceHome(), '.env') });

export type EmbedProvider = 'ollama' | 'openai';

const EMBED_MODEL = 'nomic-embed-text';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_OPENAI_EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMENSIONS = 768;

export function getEmbedProvider(): EmbedProvider {
  const env = process.env.LEAD_GEN_EMBED_PROVIDER?.toLowerCase();
  if (env === 'ollama') return 'ollama';
  return 'openai'; // default
}

export function getOllamaUrl(): string {
  return process.env.LEAD_GEN_OLLAMA_URL || DEFAULT_OLLAMA_URL;
}

export function getOpenAiModel(): string {
  return process.env.LEAD_GEN_OPENAI_EMBED_MODEL || DEFAULT_OPENAI_EMBED_MODEL;
}

function ensureOpenAiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      'OPENAI_API_KEY is not set. Add it to ~/.lead-gen/.env or export it.\n' +
      'Get an API key at https://platform.openai.com/api-keys'
    );
  }
  return key;
}

async function isOllamaAvailable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

async function isModelAvailable(url: string, model: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/tags`);
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return data.models?.some(m => m.name === model || m.name.startsWith(`${model}:`)) ?? false;
  } catch {
    return false;
  }
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function pullModelViaApi(url: string, model: string): Promise<void> {
  console.log(`Pulling model ${model}...`);
  const res = await fetch(`${url}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to pull model ${model}: ${res.status} ${body}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error(`Failed to pull model ${model}: no response body`);

  const decoder = new TextDecoder();
  let lastStatus = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n').filter(Boolean)) {
      try {
        const data = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
        if (data.error) throw new Error(`Failed to pull model ${model}: ${data.error}`);
        if (data.status && data.status !== lastStatus) {
          lastStatus = data.status;
          if (data.total && data.completed) {
            const pct = Math.round((data.completed / data.total) * 100);
            process.stdout.write(`\r${data.status} ${pct}%`);
          } else {
            console.log(data.status);
          }
        } else if (data.total && data.completed) {
          const pct = Math.round((data.completed / data.total) * 100);
          process.stdout.write(`\r${lastStatus || 'downloading'} ${pct}%`);
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Failed to pull')) throw e;
      }
    }
  }
  process.stdout.write('\n');
}

// --- Ollama embedding ---

async function ollamaEmbedBatch(
  texts: string[],
  ollamaUrl: string
): Promise<number[][]> {
  const res = await fetch(`${ollamaUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama embed failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings;
}

// --- OpenAI embedding ---

async function openaiEmbedBatch(texts: string[]): Promise<number[][]> {
  const apiKey = ensureOpenAiKey();
  const client = new OpenAI({ apiKey });
  const model = getOpenAiModel();

  const response = await client.embeddings.create({
    model,
    input: texts,
    dimensions: EMBED_DIMENSIONS,
  });

  const sorted = response.data.sort((a, b) => a.index - b.index);
  return sorted.map(d => d.embedding);
}

// --- Public API ---

export async function ensureEmbedModel(
  ollamaUrl: string = getOllamaUrl(),
  provider: EmbedProvider = getEmbedProvider()
): Promise<void> {
  if (provider === 'openai') {
    ensureOpenAiKey();
    console.log(`  Embedding provider: OpenAI (${getOpenAiModel()})`);
    return;
  }

  const available = await isOllamaAvailable(ollamaUrl);
  if (!available) {
    throw new Error(
      `Ollama is not running at ${ollamaUrl}. Please start Ollama first.\n` +
      `  macOS/Linux: ollama serve\n` +
      `  Windows: Start the Ollama application`
    );
  }

  if (await isModelAvailable(ollamaUrl, EMBED_MODEL)) {
    console.log(`  Embedding provider: Ollama (${EMBED_MODEL})`);
    return;
  }

  const shouldPull = await promptYesNo(`Model "${EMBED_MODEL}" not found. Download it now? (y/n): `);
  if (!shouldPull) {
    throw new Error(`Model "${EMBED_MODEL}" is required but was not downloaded.`);
  }
  await pullModelViaApi(ollamaUrl, EMBED_MODEL);
  console.log(`Model ${EMBED_MODEL} ready.`);
}

export async function embedBatch(
  texts: string[],
  ollamaUrl: string = getOllamaUrl(),
  provider: EmbedProvider = getEmbedProvider()
): Promise<number[][]> {
  if (texts.length === 0) return [];

  if (provider === 'openai') {
    return openaiEmbedBatch(texts);
  }
  return ollamaEmbedBatch(texts, ollamaUrl);
}

export async function embedSingle(
  text: string,
  ollamaUrl: string = getOllamaUrl(),
  provider: EmbedProvider = getEmbedProvider()
): Promise<number[]> {
  const [embedding] = await embedBatch([text], ollamaUrl, provider);
  return embedding;
}

export function composeEmbedText(lead: {
  company_name: string;
  description?: string;
  call_notes?: string;
  email_domain?: string;
}): string {
  return [lead.company_name, lead.description, lead.call_notes, lead.email_domain]
    .filter(Boolean)
    .join(' | ');
}

export function vectorToBuffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}
