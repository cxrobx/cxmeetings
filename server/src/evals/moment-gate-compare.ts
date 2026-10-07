#!/usr/bin/env tsx
/**
 * Coach-gate A/B: TypeSafe Jev (production) vs OpenAI's Decisions API.
 *
 * Same three questions, same redacted transcript tail, same OR'd thresholds as
 * `intelligence/moment-gate.ts`. Two corpora:
 *   - LABELLED: the ten frozen coach cases (`recovery-coach-cases.ts`); the
 *     gate should open exactly where `expectedSuggestion` is true. A false
 *     close is the expensive error (a lost coaching moment), so it is counted
 *     on its own.
 *   - REAL: tails cut from stored sessions every ~15 s of meeting time, the
 *     cadence the coach checks at. No labels; measures agreement between the
 *     two gates, open rate, latency and cost. `--out` writes the tails and
 *     both verdicts so disagreements can be refereed afterwards.
 *
 * Calls run one at a time, alternating which arm goes first, so neither arm's
 * latency is measured under the other's load.
 *
 * Usage:
 *   secret run -k TYPESAFE_API_KEY -k OPENAI_API_KEY -- npx tsx src/evals/moment-gate-compare.ts \
 *     [--per-session 30] [--min-rows 80] [--out <file.json>]
 * Cost: ~2k input tokens a call per arm, so ~200 windows ≈ $0.02 Jev + $0.04 Decisions.
 */
import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { jevAsk, noul, redactForJev } from '../api/jev.js';
import { QUESTIONS, WORTH_MIN, ASKED_MIN, PUSHBACK_MIN } from '../intelligence/moment-gate.js';
import { CASES } from './recovery-coach-cases.js';

const WINDOW_TAIL_CHARS = 3_600; // coach.ts
const STEP_MS = 15_000;
const DECISIONS_URL = 'https://api.openai.com/v1/decisions';
const DECISIONS_MODEL = process.env.COPILOT_DECISIONS_MODEL || 'gpt-6-luna';
const JEV_PER_M = 0.042;
const DECISIONS_PER_M = 0.10;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const perSession = Number(arg('per-session', '30'));
const minRows = Number(arg('min-rows', '80'));
const outFile = arg('out', '');

interface Verdict {
  worth: number | null;
  asked: number | null;
  pushback: number | null;
  open: boolean | null; // null = the call failed
  latencyMs: number;
  inputTokens: number;
  error?: string;
}

const isOpen = (w: number | null, a: number | null, p: number | null) =>
  (w ?? 0) >= WORTH_MIN || (a ?? 0) >= ASKED_MIN || (p ?? 0) >= PUSHBACK_MIN;

async function askJev(tail: string): Promise<Verdict> {
  const t = performance.now();
  try {
    const r = await jevAsk(tail, QUESTIONS, { timeoutMs: 5_000, label: 'gate-compare' });
    const w = noul(r.answers, 'worth_coaching');
    const a = noul(r.answers, 'asked_of_user');
    const p = noul(r.answers, 'needs_pushback');
    return { worth: w, asked: a, pushback: p, open: isOpen(w, a, p), latencyMs: Math.round(performance.now() - t), inputTokens: r.usage.input_tokens };
  } catch (e) {
    return { worth: null, asked: null, pushback: null, open: null, latencyMs: Math.round(performance.now() - t), inputTokens: 0, error: String(e) };
  }
}

/** Jev's noul (instructions + true/false criteria) as one Decisions predicate. */
const PREDICATES = Object.entries(QUESTIONS).map(([name, q]) => {
  if (q.type !== 'noul') throw new Error(`${name}: only noul questions are mapped`);
  const criteria = q.criteria
    ? `\nAnswer yes when: ${q.criteria.true}\nAnswer no when: ${q.criteria.false}`
    : '';
  return { type: 'predicate', name, instructions: `${q.instructions}${criteria}` };
});

async function askDecisions(tail: string): Promise<Verdict> {
  const key = (process.env.OPENAI_API_KEY ?? '').trim();
  const t = performance.now();
  try {
    const res = await fetch(DECISIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: DECISIONS_MODEL, input: redactForJev(tail), questions: PREDICATES }),
      signal: AbortSignal.timeout(5_000),
    });
    const latencyMs = Math.round(performance.now() - t);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as {
      answers: Array<{ name: string; probability?: number }>;
      usage?: { input_tokens?: number };
    };
    const p = (n: string) => {
      const v = json.answers.find((x) => x.name === n)?.probability;
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    const w = p('worth_coaching'), a = p('asked_of_user'), pb = p('needs_pushback');
    return { worth: w, asked: a, pushback: pb, open: isOpen(w, a, pb), latencyMs, inputTokens: json.usage?.input_tokens ?? 0 };
  } catch (e) {
    return { worth: null, asked: null, pushback: null, open: null, latencyMs: Math.round(performance.now() - t), inputTokens: 0, error: String(e) };
  }
}

interface Window { id: string; session: string; title: string; tail: string; expected?: boolean }

function realWindows(): Window[] {
  const root = join(homedir(), '.meeting-copilot', 'sessions');
  const out: Window[] = [];
  for (const id of readdirSync(root)) {
    const dbPath = join(root, id, 'session.db');
    if (!existsSync(dbPath)) continue;
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      // Sessions from before the transcript table existed have nothing to cut.
      const hasTranscript = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transcript'").get();
      if (!hasTranscript) continue;
      const rows = db.prepare("SELECT text, source, timestamp FROM transcript WHERE source != 'system' ORDER BY timestamp").all() as Array<{ text: string; source: string; timestamp: number }>;
      if (rows.length < minRows) continue;
      const title = ((db.prepare('SELECT title FROM session LIMIT 1').get() as { title?: string } | undefined)?.title ?? '').slice(0, 40);
      // Cut a tail at every STEP_MS of meeting time, then sample evenly.
      const cuts: Window[] = [];
      let next = rows[0]!.timestamp + STEP_MS;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i]!.timestamp < next) continue;
        const tail = rows.slice(0, i + 1)
          .map((r) => `${r.source === 'mic' ? '[You]' : '[Meeting]'} ${r.text}`)
          .join('\n')
          .slice(-WINDOW_TAIL_CHARS);
        if (tail.trim().length >= 20) cuts.push({ id: `${id.slice(0, 8)}@${i}`, session: id, title, tail });
        next = rows[i]!.timestamp + STEP_MS;
      }
      const stride = Math.max(1, cuts.length / perSession);
      for (let k = 0; k < cuts.length && out.filter((w) => w.session === id).length < perSession; k += stride) {
        out.push(cuts[Math.floor(k)]!);
      }
    } finally {
      db.close();
    }
  }
  return out;
}

function pct(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

async function run(windows: Window[]) {
  const rows: Array<Window & { jev: Verdict; decisions: Verdict }> = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]!;
    let jev: Verdict, decisions: Verdict;
    if (i % 2 === 0) { jev = await askJev(w.tail); decisions = await askDecisions(w.tail); }
    else { decisions = await askDecisions(w.tail); jev = await askJev(w.tail); }
    rows.push({ ...w, jev, decisions });
    if ((i + 1) % 20 === 0) console.error(`  ${i + 1}/${windows.length}`);
  }
  return rows;
}

function summarize(name: string, rows: Awaited<ReturnType<typeof run>>) {
  console.log(`\n== ${name} (${rows.length} windows)`);
  for (const arm of ['jev', 'decisions'] as const) {
    const ok = rows.filter((r) => r[arm].open !== null);
    const lat = ok.map((r) => r[arm].latencyMs);
    const tok = ok.reduce((s, r) => s + r[arm].inputTokens, 0);
    const rate = arm === 'jev' ? JEV_PER_M : DECISIONS_PER_M;
    const errors = rows.filter((r) => r[arm].open === null);
    console.log(
      `${arm.padEnd(10)} ok ${ok.length}/${rows.length} · open ${ok.filter((r) => r[arm].open).length}`
      + ` · p50 ${pct(lat, 0.5)} ms · p95 ${pct(lat, 0.95)} ms · max ${pct(lat, 1)} ms`
      + ` · ${Math.round(tok / Math.max(1, ok.length))} tok/call · $${((tok / 1e6) * rate * 1000 / Math.max(1, ok.length)).toFixed(4)}/1k calls`,
    );
    if (errors.length) console.log(`           first error: ${errors[0]![arm].error?.slice(0, 200)}`);
    const labelled = ok.filter((r) => r.expected !== undefined);
    if (labelled.length) {
      const right = labelled.filter((r) => r[arm].open === r.expected).length;
      const falseClose = labelled.filter((r) => r.expected && r[arm].open === false).map((r) => r.id);
      console.log(`           labelled ${right}/${labelled.length} right · false closes: ${falseClose.join(', ') || 'none'}`);
    }
  }
  const both = rows.filter((r) => r.jev.open !== null && r.decisions.open !== null);
  const agree = both.filter((r) => r.jev.open === r.decisions.open).length;
  console.log(`agreement on open/closed: ${agree}/${both.length}`
    + ` · Jev-open-only ${both.filter((r) => r.jev.open && !r.decisions.open).length}`
    + ` · Decisions-open-only ${both.filter((r) => !r.jev.open && r.decisions.open).length}`);
  for (const q of ['worth', 'asked', 'pushback'] as const) {
    const pairs = both.filter((r) => r.jev[q] !== null && r.decisions[q] !== null);
    const mae = pairs.reduce((s, r) => s + Math.abs(r.jev[q]! - r.decisions[q]!), 0) / Math.max(1, pairs.length);
    console.log(`  ${q.padEnd(9)} mean |Δp| ${mae.toFixed(3)}`);
  }
}

async function main() {
  for (const k of ['TYPESAFE_API_KEY', 'OPENAI_API_KEY']) {
    if (!(process.env[k] ?? '').trim()) { console.error(`${k} is not set (run under secret run)`); process.exit(2); }
  }
  // Warm both connections so the first measured call is not a TLS handshake.
  await askJev('[Meeting] Thanks for joining.\n[You] Happy to be here.');
  await askDecisions('[Meeting] Thanks for joining.\n[You] Happy to be here.');

  const labelled: Window[] = CASES.map((c) => ({
    id: c.id, session: 'frozen', title: 'frozen', tail: c.prompt.transcriptWindow, expected: c.expectedSuggestion,
  }));
  const labelledRows = await run(labelled);
  summarize('LABELLED (frozen coach cases)', labelledRows);

  const real = realWindows();
  console.error(`real windows: ${real.length} from ${new Set(real.map((w) => w.session)).size} sessions`);
  const realRows = await run(real);
  summarize('REAL (stored sessions)', realRows);

  if (outFile) {
    writeFileSync(outFile, JSON.stringify({ labelled: labelledRows, real: realRows }, null, 2));
    console.error(`wrote ${outFile}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
