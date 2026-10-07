/**
 * Jev gate in front of the coach's generative call.
 *
 * Measured on ten recorded sessions (2026-09-19): the coach ran 112 times in one
 * 40-minute meeting and surfaced 2 cards. 85 of those evaluations paid for a
 * Terra call ($0.0027 each) and were then withheld below the priority floor.
 * This gate spends ~$0.000042 to decide whether the Terra call is worth making,
 * which is what makes running the coach in EVERY meeting cheaper than today's
 * opt-in behaviour rather than dearer.
 *
 * THE ASYMMETRY THAT SETS THE THRESHOLDS (jev.md rule 3 — a threshold encodes
 * the cost of being wrong, not a quality bar):
 *   - a false OPEN  costs $0.0027 and nothing else; Terra's own priority and
 *     confidence floors still decide whether a card is shown
 *   - a false CLOSE costs a coaching moment in a live client meeting
 * So the signals compose with OR, the thresholds sit low, and any failure at all
 * opens the gate. This gate may only ever SAVE a call — it must never be the
 * reason coaching does not happen.
 */
import { isJevAvailable, jevAsk, noul, redactForJev, type JevQuestion } from '../api/jev.js';
import { isOpenAiApiAvailable } from '../api/openai.js';
import { beginLlmRequest, recordLlmUsage } from '../api/budget.js';
import { log } from '../logging.js';

/** Budget for the gate itself. Jev measures ~175ms p50; this is the tail stop. */
const GATE_TIMEOUT_MS = 800;

// Any ONE of these opening is enough. They are deliberately low: the point is to
// drop the empty periodic ticks, not to be clever about which moment it is.
export const WORTH_MIN = 0.35;
export const ASKED_MIN = 0.50;
export const PUSHBACK_MIN = 0.40;

export const QUESTIONS: Record<string, JevQuestion> = {
  worth_coaching: {
    type: 'noul',
    instructions:
      'A meeting copilot is listening and can privately advise the user ("[You]") on what to say next. Is there a live moment in the most recent part of this conversation worth advising them about right now?',
    criteria: {
      true: 'Something is happening the user could handle better or worse in the next few sentences — a question put to them, a challenge or objection, pressure toward a commitment, a claim they should qualify, a decision being made, or a misunderstanding worth correcting.',
      false: 'Nothing is at stake in the immediate exchange: small talk, a greeting, an acknowledgment, a sentence fragment, or the user simply explaining something at their own pace.',
    },
  },
  asked_of_user: {
    type: 'noul',
    instructions:
      'Has the OTHER side put a question or request to the user ("[You]") that the user is now expected to answer?',
    criteria: {
      true: 'A direct question, or a request for the user\'s opinion, experience, recommendation, or agreement, that they are clearly expected to respond to.',
      false: 'The other side is explaining, agreeing, or narrating; or the user is the one speaking.',
    },
  },
  needs_pushback: {
    type: 'noul',
    instructions:
      'Is the other side pressing the user toward a commitment, a scope expansion, a discount, or a deadline that the user should qualify or push back on before agreeing?',
    criteria: {
      true: 'Pressure toward a price, date, scope, or guarantee, where agreeing without qualification would cost the user something.',
      false: 'An ordinary exchange with no commitment at stake.',
    },
  },
};

export interface MomentGateVerdict {
  /** Whether the expensive generative call should proceed. */
  open: boolean;
  /** Why, for the event log: 'signal' | 'unavailable' | 'error' | 'disabled'. */
  reason: string;
  worth: number | null;
  asked: number | null;
  pushback: number | null;
  latencyMs: number;
}

/** Injectable so the coach's tests never touch the network. */
export type MomentGate = (tail: string, signal?: AbortSignal) => Promise<MomentGateVerdict>;

const OPEN_UNGATED: Omit<MomentGateVerdict, 'reason'> = {
  open: true,
  worth: null,
  asked: null,
  pushback: null,
  latencyMs: 0,
};

/**
 * Ask Jev whether this moment justifies the generative call.
 *
 * Returns `open: true` whenever Jev is unavailable, errors, times out, or
 * answers in a shape we do not recognise — today's behaviour is the floor.
 */
export const jevMomentGate: MomentGate = async (tail, signal) => {
  if (!isJevAvailable()) return { ...OPEN_UNGATED, reason: 'unavailable' };
  if (!tail || tail.trim().length < 20) return { ...OPEN_UNGATED, reason: 'too-short' };

  const started = Date.now();
  try {
    const result = await jevAsk(tail, QUESTIONS, {
      signal,
      timeoutMs: GATE_TIMEOUT_MS,
      label: 'coach-gate',
    });
    const worth = noul(result.answers, 'worth_coaching');
    const asked = noul(result.answers, 'asked_of_user');
    const pushback = noul(result.answers, 'needs_pushback');

    // An unreadable answer is not evidence of a quiet moment.
    if (worth === null && asked === null && pushback === null) {
      return { ...OPEN_UNGATED, reason: 'unparsed', latencyMs: result.latencyMs };
    }

    const open =
      (worth ?? 0) >= WORTH_MIN
      || (asked ?? 0) >= ASKED_MIN
      || (pushback ?? 0) >= PUSHBACK_MIN;

    return { open, reason: open ? 'signal' : 'quiet', worth, asked, pushback, latencyMs: result.latencyMs };
  } catch (error) {
    // Includes the budget guard: if the session's ceiling is spent, the coach
    // path fails on its own terms a moment later rather than silently here.
    const message = error instanceof Error ? error.message : String(error);
    log('intelligence/moment-gate', `gate failed open: ${message}`);
    return { ...OPEN_UNGATED, reason: 'error', latencyMs: Date.now() - started };
  }
};

/** Gate that always opens — the behaviour before this existed. */
export const alwaysOpenGate: MomentGate = async () => ({ ...OPEN_UNGATED, reason: 'disabled' });

// ─── OpenAI Decisions provider (opt-in: COPILOT_GATE_PROVIDER=decisions) ─────
//
// Same three questions, each mapped to a Decisions predicate. Its probabilities
// sit lower than Jev's on the same moment, so it has its own thresholds: worth
// was tuned to 0.05 on 176 real windows (2026-10-06), then held out on 172
// others with the thresholds fixed beforehand — Opus-refereed recall 33/33 of
// open moments, 31% of coach calls saved vs Jev's 10%, p50 94 ms vs 141 ms.
// `npm run eval:moment-gate` reproduces both arms.
const DECISIONS_URL = 'https://api.openai.com/v1/decisions';
const DECISIONS_MODEL = process.env.COPILOT_DECISIONS_MODEL || 'gpt-6-luna';
const DECISIONS_INPUT_PER_MILLION = 0.10; // no output charge

export const DECISIONS_THRESHOLDS = { worth: 0.05, asked: 0.50, pushback: 0.40 } as const;

/** Jev's noul (instructions + true/false criteria) as one Decisions predicate. */
export const DECISIONS_PREDICATES = Object.entries(QUESTIONS).map(([name, q]) => {
  if (q.type !== 'noul') throw new Error(`${name}: only noul questions are mapped`);
  const criteria = q.criteria
    ? `\nAnswer yes when: ${q.criteria.true}\nAnswer no when: ${q.criteria.false}`
    : '';
  return { type: 'predicate' as const, name, instructions: `${q.instructions}${criteria}` };
});

/** Same contract as `jevMomentGate`: any failure at all opens the gate. */
export const decisionsMomentGate: MomentGate = async (tail, signal) => {
  if (!isOpenAiApiAvailable()) return { ...OPEN_UNGATED, reason: 'unavailable' };
  if (!tail || tail.trim().length < 20) return { ...OPEN_UNGATED, reason: 'too-short' };

  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GATE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    beginLlmRequest();
    const res = await fetch(DECISIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${(process.env.OPENAI_API_KEY ?? '').trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: DECISIONS_MODEL, input: redactForJev(tail), questions: DECISIONS_PREDICATES }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Decisions HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      answers?: Array<{ name?: string; probability?: unknown }>;
      usage?: { input_tokens?: number };
    };
    const latencyMs = Date.now() - started;
    const inputTokens = json.usage?.input_tokens ?? 0;
    recordLlmUsage({
      inputTokens,
      outputTokens: 0,
      inputDollarsPerMillion: DECISIONS_INPUT_PER_MILLION,
      outputDollarsPerMillion: 0,
    });
    const p = (name: string) => {
      const v = Array.isArray(json.answers) ? json.answers.find((a) => a?.name === name)?.probability : undefined;
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    const worth = p('worth_coaching');
    const asked = p('asked_of_user');
    const pushback = p('needs_pushback');

    if (worth === null && asked === null && pushback === null) {
      return { ...OPEN_UNGATED, reason: 'unparsed', latencyMs };
    }

    const open =
      (worth ?? 0) >= DECISIONS_THRESHOLDS.worth
      || (asked ?? 0) >= DECISIONS_THRESHOLDS.asked
      || (pushback ?? 0) >= DECISIONS_THRESHOLDS.pushback;
    log('intelligence/moment-gate', `decisions model=${DECISIONS_MODEL} latencyMs=${latencyMs} in=${inputTokens} open=${open}`);
    return { open, reason: open ? 'signal' : 'quiet', worth, asked, pushback, latencyMs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('intelligence/moment-gate', `decisions gate failed open: ${message}`);
    return { ...OPEN_UNGATED, reason: 'error', latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
};

/** The gate the coach uses: Jev unless `COPILOT_GATE_PROVIDER=decisions`. */
export function selectedMomentGate(): MomentGate {
  return (process.env.COPILOT_GATE_PROVIDER ?? '').trim().toLowerCase() === 'decisions'
    ? decisionsMomentGate
    : jevMomentGate;
}
