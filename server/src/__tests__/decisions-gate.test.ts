import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { decisionsMomentGate, jevMomentGate, selectedMomentGate, DECISIONS_THRESHOLDS } from '../intelligence/moment-gate.js';
import { resetLlmBudget, setLlmBudgetExceededHandler, getLlmBudgetSnapshot, beginLlmRequest } from '../api/budget.js';

const KEY = 'OPENAI_API_KEY';
const KILL = 'COPILOT_DISABLE_PAID_API';
const PROVIDER = 'COPILOT_GATE_PROVIDER';

function decisionsResponse(answers: unknown, inputTokens = 1_500) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ answers, usage: { input_tokens: inputTokens } }),
    text: async () => '',
  } as unknown as Response;
}

const probs = (worth: number, asked: number, pushback: number) => [
  { name: 'worth_coaching', probability: worth },
  { name: 'asked_of_user', probability: asked },
  { name: 'needs_pushback', probability: pushback },
];

const TAIL = '[Meeting] So would you also develop that out for us as well?\n[You] Uh, I would need to check the scope on that.';

describe('decisions moment gate', () => {
  const saved = { key: process.env[KEY], kill: process.env[KILL], provider: process.env[PROVIDER] };
  const restore = (name: string, v: string | undefined) => (v === undefined ? delete process.env[name] : (process.env[name] = v));
  beforeEach(() => {
    process.env[KEY] = 'sk-test';
    delete process.env[KILL];
    resetLlmBudget();
    setLlmBudgetExceededHandler(() => {});
  });
  afterEach(() => {
    restore(KEY, saved.key);
    restore(KILL, saved.kill);
    restore(PROVIDER, saved.provider);
    vi.restoreAllMocks();
  });

  it('closes only when every signal is below its own threshold', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(decisionsResponse(probs(0.02, 0.1, 0.1)));
    const v = await decisionsMomentGate(TAIL);
    expect(v.open).toBe(false);
    expect(v.reason).toBe('quiet');
  });

  it('opens on a worth probability Jev would call quiet (its threshold is lower)', async () => {
    expect(DECISIONS_THRESHOLDS.worth).toBeLessThan(0.35);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(decisionsResponse(probs(0.06, 0.01, 0.01)));
    expect((await decisionsMomentGate(TAIL)).open).toBe(true);
  });

  it('opens on ANY single signal — a question to the user is enough', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(decisionsResponse(probs(0.01, 0.92, 0.01)));
    expect((await decisionsMomentGate(TAIL)).open).toBe(true);
  });

  it('opens on pushback alone', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(decisionsResponse(probs(0.01, 0.01, 0.53)));
    expect((await decisionsMomentGate(TAIL)).open).toBe(true);
  });

  it('redacts the input sent over the wire and sends predicates', async () => {
    let sent: { input: string; questions: Array<{ type: string; name: string }> } | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      sent = JSON.parse(String((init as RequestInit).body));
      return decisionsResponse(probs(0.5, 0.5, 0.5));
    });
    await decisionsMomentGate(`${TAIL}\n[Meeting] reach me at bob@example.com`);
    expect(sent!.input).not.toContain('bob@example.com');
    expect(sent!.input).toContain('<email>');
    expect(sent!.questions.map((q) => q.name)).toEqual(['worth_coaching', 'asked_of_user', 'needs_pushback']);
    expect(sent!.questions.every((q) => q.type === 'predicate')).toBe(true);
  });

  it('fails OPEN when the request errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const v = await decisionsMomentGate(TAIL);
    expect(v.open).toBe(true);
    expect(v.reason).toBe('error');
  });

  it('fails OPEN on a non-200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' } as unknown as Response);
    expect((await decisionsMomentGate(TAIL)).open).toBe(true);
  });

  it('fails OPEN on a timeout', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation((_u, init) => new Promise((_, reject) => {
        (init as RequestInit).signal!.addEventListener('abort', () => reject(new Error('aborted')));
      }));
      const pending = decisionsMomentGate(TAIL);
      await vi.advanceTimersByTimeAsync(1_000);
      const v = await pending;
      expect(v.open).toBe(true);
      expect(v.reason).toBe('error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails OPEN when the answers are unreadable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(decisionsResponse([{ name: 'worth_coaching', probability: 'high' }]));
    const v = await decisionsMomentGate(TAIL);
    expect(v.open).toBe(true);
    expect(v.reason).toBe('unparsed');
  });

  it('fails OPEN without calling out when the paid-API killswitch is set', async () => {
    process.env[KILL] = '1';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const v = await decisionsMomentGate(TAIL);
    expect(v.open).toBe(true);
    expect(v.reason).toBe('unavailable');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails OPEN without calling out when there is no key', async () => {
    delete process.env[KEY];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect((await decisionsMomentGate(TAIL)).reason).toBe('unavailable');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails OPEN when the budget ceiling is already spent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (let i = 0; i < 500; i++) {
      try {
        beginLlmRequest();
      } catch {
        break;
      }
    }
    const v = await decisionsMomentGate(TAIL);
    expect(v.open).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('counts its spend against the session budget at input-only pricing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(decisionsResponse(probs(0.9, 0.9, 0.9), 2_000));
    await decisionsMomentGate(TAIL);
    const snap = getLlmBudgetSnapshot();
    expect(snap.requests).toBe(1);
    expect(snap.tokens).toBe(2_000);
    expect(snap.estimatedDollars).toBeCloseTo((2_000 / 1e6) * 0.10, 8);
  });

  it('does not call out for a too-short tail', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect((await decisionsMomentGate('hi')).open).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is opt-in: Jev stays the default provider', () => {
    delete process.env[PROVIDER];
    expect(selectedMomentGate()).toBe(jevMomentGate);
    process.env[PROVIDER] = 'jev';
    expect(selectedMomentGate()).toBe(jevMomentGate);
    process.env[PROVIDER] = 'decisions';
    expect(selectedMomentGate()).toBe(decisionsMomentGate);
  });
});
