/**
 * `npm run eval:chat` — replays every real meeting-chat question through two
 * OpenAI models and has a different model (Opus, subscription CLI) judge the
 * answers blind.
 *
 * Each question is rebuilt the way ChatService builds it (the real snapshot
 * code via its private snapshotInput, the stored earlier turns via
 * historyFor), but as of the moment it was asked: the transcript and
 * summaries are cut at the question's time. What a replay cannot have is the
 * live server's context (private goals, ranked reference docs, live agenda
 * coverage), so both arms go without it.
 *
 * The judge sees each pair twice, in both orders. A model wins a question only
 * when both orders pick it; a split is a tie. That cancels position bias,
 * which is the usual way a blind A/B lies.
 *
 *   npm run eval:chat                                    # luna vs gpt-6.2-sol
 *   npm run eval:chat -- --a gpt-6-luna --b gpt-6.2-astra
 *   npm run eval:chat -- --limit 3 --out <dir>
 *   npm run eval:chat -- --a gpt-6.2-sol --b gpt-6.2-sol --tier-a default --tier-b fast --no-judge --rounds 3
 *     (a latency A/B of OpenAI's fast tier: same model, no judge, rounds interleaved)
 *
 * Metered: both arms bill OpenAI (the session budget guard's prices). The
 * judge runs on the subscription CLI.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import dotenv from 'dotenv';

const USER_ENV_PATH = join(homedir(), '.meeting-copilot', '.env');
if (existsSync(USER_ENV_PATH)) dotenv.config({ path: USER_ENV_PATH });
else dotenv.config();

const { isOpenAiApiAvailable, openaiFastResearchStream } = await import('../api/openai.js');
const { getLlmBudgetSnapshot, resetLlmBudget } = await import('../api/budget.js');
const { claudeSuggest } = await import('../claude-cli.js');
const { CHAT_SYSTEM, DRAFT_TASK_TOOL, buildMeetingSnapshot, renderUserTurn } = await import('../chat/context.js');
const { ChatService, historyFor } = await import('../chat/service.js');
const { readChat } = await import('../chat/store.js');
const { parseFirstJsonObject } = await import('../intelligence/first-json.js');

const SESSIONS = join(homedir(), '.meeting-copilot', 'sessions');
const JUDGE_MODEL = 'claude-opus-5-5';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const A = arg('a', 'gpt-6-luna');
const B = arg('b', 'gpt-6.2-sol');
const TIER_A = arg('tier-a', 'default');
const TIER_B = arg('tier-b', 'default');
const NO_JUDGE = process.argv.includes('--no-judge');
const ROUNDS = Math.max(1, Number(arg('rounds', '1')) || 1);
const LIMIT = Number(arg('limit', '0')) || Infinity;
const OUT = arg('out', join(process.env.TMPDIR ?? '/tmp', `chat-replay-${Date.now()}`));

interface Case {
  sessionId: string;
  title: string;
  question: string;
  system: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  user: string;
}

interface Answer {
  model: string;
  text: string;
  sources: Array<{ url: string; title: string }>;
  drafts: unknown[];
  ttftMs: number | null;
  totalMs: number;
  dollars: number;
  tokens: number;
  error?: string;
}

function collectCases(): Case[] {
  const svc = new ChatService({ sessionDir: (id) => join(SESSIONS, id) }) as unknown as {
    snapshotInput(sessionId: string, hint: string): Parameters<typeof buildMeetingSnapshot>[0];
  };
  const cases: Case[] = [];
  for (const sessionId of readdirSync(SESSIONS)) {
    const db = join(SESSIONS, sessionId, 'session.db');
    if (!existsSync(db)) continue;
    let thread;
    try {
      thread = readChat(db);
    } catch {
      continue;
    }
    for (const m of thread) {
      if (m.role !== 'user') continue;
      const input = svc.snapshotInput(sessionId, m.content);
      const at = m.createdAt;
      const asked = {
        ...input,
        now: at,
        live: !input.endedAt || at < input.endedAt,
        // The stored pulse is the meeting's last one; a pulse read after the
        // question was asked is dropped. (Cards carry no time in the snapshot,
        // so they still come in whole: a known leak, the same for both arms.)
        pulse: input.pulse && input.startedAt && input.startedAt + input.pulse.minutesIn * 60_000 > at ? null : input.pulse,
        transcript: input.transcript.filter((t) => t.timestamp <= at),
        summaries: input.summaries.filter((s) => (s as { windowEnd?: number }).windowEnd == null || (s as { windowEnd: number }).windowEnd <= at),
      };
      const today = new Date(at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      cases.push({
        sessionId,
        title: input.title,
        question: m.content || '(attachment only)',
        system: `${CHAT_SYSTEM}\nToday is ${today}.\n\n${buildMeetingSnapshot(asked)}`,
        history: historyFor(thread, m.id),
        user: renderUserTurn(m.content, m.attachments),
      });
    }
  }
  return cases.slice(0, LIMIT);
}

async function answer(c: Case, model: string, tier: string): Promise<Answer> {
  resetLlmBudget();
  const started = Date.now();
  let first = 0;
  try {
    const r = await openaiFastResearchStream({
      systemPrompt: c.system,
      history: c.history,
      userContent: c.user,
      model,
      label: `eval-chat:${model}:${tier}`,
      serviceTier: tier,
      functions: [DRAFT_TASK_TOOL],
      onDelta: () => {
        if (!first) first = Date.now();
      },
    });
    const b = getLlmBudgetSnapshot();
    return {
      model,
      text: r.text,
      sources: r.sources,
      drafts: r.calls.map((x) => x.arguments),
      ttftMs: first ? first - started : null,
      totalMs: Date.now() - started,
      dollars: b.estimatedDollars,
      tokens: b.tokens,
    };
  } catch (err) {
    const b = getLlmBudgetSnapshot();
    return { model, text: '', sources: [], drafts: [], ttftMs: null, totalMs: Date.now() - started, dollars: b.estimatedDollars, tokens: b.tokens, error: err instanceof Error ? err.message : String(err) };
  }
}

function shown(a: Answer): string {
  const parts = [a.error ? `(failed: ${a.error})` : a.text || '(empty)'];
  if (a.sources.length) parts.push(`Sources: ${a.sources.map((s) => s.url).join(', ')}`);
  if (a.drafts.length) parts.push(`Task drafts it made: ${JSON.stringify(a.drafts)}`);
  return parts.join('\n\n');
}

const JUDGE_SYSTEM = [
  'You judge two answers from a meeting assistant\'s chat. The user typed the question during or just after the meeting described in the context.',
  'Judge what the user needed: correct and grounded in the meeting (quotes exact, times right, nothing invented), directly answers the question, follows the assistant\'s own rules (short unless asked for more, says plainly when the meeting does not cover it, drafts tasks when asked).',
  'Length is not quality. A shorter answer that is right beats a longer one that pads or guesses.',
  'Reply with one JSON object only: {"winner":"A"|"B"|"tie","a_score":1-10,"b_score":1-10,"reason":"one or two sentences"}',
].join('\n');

interface Verdict { winner: 'A' | 'B' | 'tie'; a_score: number; b_score: number; reason: string }

async function judge(c: Case, first: Answer, second: Answer): Promise<Verdict | null> {
  const earlier = c.history.length ? `\n\n# Earlier turns\n${c.history.map((h) => `${h.role}: ${h.content}`).join('\n\n')}` : '';
  const prompt = `# The assistant's context and rules\n${c.system}${earlier}\n\n# The question\n${c.user}\n\n# Answer A\n${shown(first)}\n\n# Answer B\n${shown(second)}`;
  const text = await claudeSuggest(prompt, JUDGE_SYSTEM, undefined, undefined, { model: JUDGE_MODEL, effort: 'high', cold: true, maxTurns: 1 });
  return parseFirstJsonObject<Verdict>(text, (v) => v.winner === 'A' || v.winner === 'B' || v.winner === 'tie');
}

async function main() {
  if (!isOpenAiApiAvailable()) throw new Error('OpenAI API is not available (key missing or COPILOT_DISABLE_PAID_API=1).');
  const cases = collectCases();
  mkdirSync(OUT, { recursive: true });
  console.log(`${cases.length} chat questions · A=${A} B=${B} · judge=${JUDGE_MODEL} · out=${OUT}`);
  const rows: Array<Record<string, any>> = [];
  const LA = `${A}${TIER_A !== 'default' ? `:${TIER_A}` : ''}`;
  const LB = `${B}${TIER_B !== 'default' ? `:${TIER_B}` : ''}`;
  for (let round = 1; round <= ROUNDS; round++) {
    for (const [i, c] of cases.entries()) {
      // One arm at a time: the budget counter is process-wide, so two answers
      // in flight would read each other's dollars. Which goes first alternates,
      // so neither always meets a warm or cold moment.
      const flip = (i + round) % 2 === 1;
      let a: Answer, b: Answer;
      if (flip) { b = await answer(c, B, TIER_B); a = await answer(c, A, TIER_A); }
      else { a = await answer(c, A, TIER_A); b = await answer(c, B, TIER_B); }
      let v1: Verdict | null = null, v2: Verdict | null = null, winner = 'unjudged', scoreA: number | null = null, scoreB: number | null = null;
      if (!NO_JUDGE) {
        // Two judgments, both orders. A model wins only if both pick it.
        [v1, v2] = await Promise.all([judge(c, a, b), judge(c, b, a)]);
        const pick1 = v1 ? (v1.winner === 'A' ? LA : v1.winner === 'B' ? LB : 'tie') : 'error';
        const pick2 = v2 ? (v2.winner === 'A' ? LB : v2.winner === 'B' ? LA : 'tie') : 'error';
        winner = pick1 === pick2 ? pick1 : 'tie';
        scoreA = v1 && v2 ? (v1.a_score + v2.b_score) / 2 : null;
        scoreB = v1 && v2 ? (v1.b_score + v2.a_score) / 2 : null;
      }
      rows.push({ ...c, system: undefined, round, a, b, v1, v2, winner, scoreA, scoreB });
      console.log(`[r${round} ${i + 1}/${cases.length}] ${winner.padEnd(14)} ${LA} ${scoreA ?? '-'} vs ${LB} ${scoreB ?? '-'} · $${a.dollars.toFixed(4)} vs $${b.dollars.toFixed(4)} · ${a.totalMs}ms vs ${b.totalMs}ms · ${c.question.slice(0, 50).replace(/\s+/g, ' ')}`);
    }
  }
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(rows, null, 2));

  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((n, r) => n + f(r), 0);
  const med = (xs: number[]) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
  const wins = (m: string) => rows.filter((r) => r.winner === m).length;
  const pct = (xs: number[], p: number) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : 0; };
  const scored = rows.filter((r) => r.scoreA != null);
  console.log('\n── Summary ──');
  if (!NO_JUDGE) console.log(`wins: ${LA} ${wins(LA)} · ${LB} ${wins(LB)} · tie ${rows.length - wins(LA) - wins(LB)}`);
  for (const [label, key] of [[LA, 'a'], [LB, 'b']] as const) {
    const total = rows.map((r) => r[key].totalMs as number);
    const first = rows.flatMap((r) => (r[key].ttftMs ? [r[key].ttftMs as number] : []));
    console.log(`${label}: total p50 ${pct(total, 0.5)} p90 ${pct(total, 0.9)} max ${Math.max(...total)} · first word p50 ${pct(first, 0.5)} p90 ${pct(first, 0.9)} max ${Math.max(...first)} · per round p50 ${Array.from({ length: ROUNDS }, (_, k) => pct(rows.filter((r) => r.round === k + 1).map((r) => r[key].totalMs as number), 0.5)).join('/')}`);
  }
  if (!NO_JUDGE) console.log(`mean score: ${A} ${(sum((r) => r.scoreA ?? 0) / (scored.length || 1)).toFixed(2)} · ${B} ${(sum((r) => r.scoreB ?? 0) / (scored.length || 1)).toFixed(2)}`);
  console.log(`cost per turn: ${A} $${(sum((r) => r.a.dollars) / rows.length).toFixed(4)} · ${B} $${(sum((r) => r.b.dollars) / rows.length).toFixed(4)}`);
  console.log(`median total ms: ${A} ${med(rows.map((r) => r.a.totalMs))} · ${B} ${med(rows.map((r) => r.b.totalMs))}`);
  console.log(`median first-word ms: ${A} ${med(rows.flatMap((r) => (r.a.ttftMs ? [r.a.ttftMs] : [])))} · ${B} ${med(rows.flatMap((r) => (r.b.ttftMs ? [r.b.ttftMs] : [])))}`);
  console.log(`errors: ${A} ${rows.filter((r) => r.a.error).length} · ${B} ${rows.filter((r) => r.b.error).length}`);
}

await main();
process.exit(0);
