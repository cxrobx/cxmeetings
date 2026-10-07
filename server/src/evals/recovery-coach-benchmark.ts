import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import dotenv from 'dotenv';
import OpenAI from 'openai';
import { OpenAIRealtimeWS } from 'openai/realtime/ws';

import { openaiStructuredJson } from '../api/openai.js';
import { resetLlmBudget } from '../api/budget.js';
import { MODEL_CONFIG } from '../model-config.js';
// Imported, not copied: this sat at 4_000 after production moved to 6_000, so
// the benchmark was scoring `usable` against a deadline the app no longer used.
import { ADVICE_DEADLINE_MS } from '../intelligence/coach.js';
import {
  buildCoachPrompt,
  COACH_SCHEMA,
  COACH_SYSTEM,
  type CoachIncidentType,
  type CoachKind,
  type CoachSuggestionResult,
} from '../intelligence/prompts/coach.v1.js';
import { CASES, type EvalCase } from './recovery-coach-cases.js';

const USER_ENV_PATH = join(homedir(), '.meeting-copilot', '.env');
if (existsSync(USER_ENV_PATH)) dotenv.config({ path: USER_ENV_PATH });
else dotenv.config();


const REQUEST_TIMEOUT_MS = 12_000;
const MAX_OUTPUT_TOKENS = 240;
const REALTIME_MAX_OUTPUT_TOKENS = Number(
  process.env.COPILOT_REALTIME_COACH_MAX_OUTPUT_TOKENS || 384,
);
const DEEPSEEK_MAX_OUTPUT_TOKENS = Number(
  process.env.COPILOT_DEEPSEEK_COACH_MAX_OUTPUT_TOKENS || 512,
);
const REALTIME_MODEL = process.env.COPILOT_REALTIME_COACH_MODEL || 'gpt-realtime-2.1-mini';
// Follow whatever the app actually ships as the coach, so `npm run eval:coach`
// always scores production. Set COPILOT_COACH_MODEL to A/B another model
// against the same ten cases (that is how Luna won the seat from Terra).
const COACH_MODEL = MODEL_CONFIG.coach;
const DEEPSEEK_MODEL = process.env.COPILOT_DEEPSEEK_COACH_MODEL || 'deepseek-v4-flash';

type ReasoningEffort = 'minimal' | 'low';

interface Invocation {
  raw: string;
  latencyMs: number;
  ttftMs: number | null;
}

interface Provider {
  name: string;
  model: string;
  available: boolean;
  skipReason?: string;
  connectMs?: number;
  connect?(): Promise<void>;
  invoke(caseId: string, prompt: string): Promise<Invocation>;
  close?(): void;
}

interface ParsedCoachResult {
  value: CoachSuggestionResult | null;
  schemaValid: boolean;
  error?: string;
}

interface CaseResult {
  caseId: string;
  latencyMs: number;
  ttftMs: number | null;
  schemaValid: boolean;
  decisionCorrect: boolean;
  incidentCorrect: boolean;
  priorityConsistent: boolean;
  qualityPass: boolean;
  withinDeadline: boolean;
  usable: boolean;
  score: number;
  suggestion: CoachSuggestionResult | null;
  issues: string[];
  error?: string;
  rawSnippet: string;
}

interface ProviderResult {
  provider: string;
  model: string;
  connectMs?: number;
  cases: CaseResult[];
}

const WARMUP_PROMPT = buildCoachPrompt({
  meetingTitle: 'Synthetic warmup',
  attendees: 'You, client',
  agendaSummary: '[covered] Introductions',
  recentSuggestions: [],
  momentHint: 'Routine transcript growth check.',
  triggerSource: 'system',
  transcriptWindow: '[Meeting] Thanks for joining.\n[You] Happy to be here.',
});

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function extractJson(raw: string): string {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
}

function parseCoachResult(raw: string): ParsedCoachResult {
  if (!raw.trim()) return { value: null, schemaValid: false, error: 'empty output' };
  try {
    const value = JSON.parse(extractJson(raw)) as Record<string, unknown>;
    const kinds: CoachKind[] = ['mention', 'ask', 'address'];
    const incidents: CoachIncidentType[] = [
      'none',
      'pressure',
      'objection',
      'bad_answer',
      'overcommitment',
      'confusion',
      'contradiction',
      'agenda_risk',
      'decision',
      'commitment',
      'question',
    ];
    const invalidFields = [
      typeof value.hasSuggestion === 'boolean' ? '' : 'hasSuggestion',
      kinds.includes(value.kind as CoachKind) ? '' : 'kind',
      incidents.includes(value.incidentType as CoachIncidentType) ? '' : 'incidentType',
      typeof value.priority === 'number' && Number.isFinite(value.priority) ? '' : 'priority',
      typeof value.confidence === 'number' && Number.isFinite(value.confidence) ? '' : 'confidence',
      typeof value.headline === 'string' ? '' : 'headline',
      typeof value.phrasing === 'string' ? '' : 'phrasing',
      typeof value.why === 'string' ? '' : 'why',
      typeof value.triggerQuote === 'string' ? '' : 'triggerQuote',
      typeof value.expiresInMs === 'number' && Number.isInteger(value.expiresInMs)
        ? ''
        : 'expiresInMs',
    ].filter(Boolean);
    const valid = invalidFields.length === 0;
    if (typeof value.hasSuggestion !== 'boolean') {
      return {
        value: null,
        schemaValid: false,
        error: `schema mismatch: ${invalidFields.join(', ')}`,
      };
    }
    return {
      // Match the production coach parser: the intervention decision is
      // recoverable as long as hasSuggestion is present, while strict schema
      // adherence remains a separately reported metric.
      value: {
        hasSuggestion: value.hasSuggestion,
        kind: kinds.includes(value.kind as CoachKind) ? value.kind as CoachKind : 'address',
        incidentType: incidents.includes(value.incidentType as CoachIncidentType)
          ? value.incidentType as CoachIncidentType
          : 'none',
        priority: typeof value.priority === 'number' && Number.isFinite(value.priority)
          ? value.priority
          : 0,
        confidence: typeof value.confidence === 'number' && Number.isFinite(value.confidence)
          ? value.confidence
          : 0,
        headline: typeof value.headline === 'string' ? value.headline : '',
        phrasing: typeof value.phrasing === 'string' ? value.phrasing : '',
        why: typeof value.why === 'string' ? value.why : '',
        triggerQuote: typeof value.triggerQuote === 'string' ? value.triggerQuote : '',
        expiresInMs: typeof value.expiresInMs === 'number' && Number.isFinite(value.expiresInMs)
          ? value.expiresInMs
          : 15_000,
      },
      schemaValid: valid,
      error: valid ? undefined : `schema mismatch: ${invalidFields.join(', ')}`,
    };
  } catch (error) {
    return {
      value: null,
      schemaValid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function words(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function numericTokens(text: string): string[] {
  return text.toLowerCase().match(/\b\d[\d,.%]*\b/g) ?? [];
}

const NUMBER_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  twenty: '20',
  thirty: '30',
  forty: '40',
  fifty: '50',
  sixty: '60',
  seventy: '70',
  eighty: '80',
  ninety: '90',
};

function groundedNumber(token: string, prompt: string): boolean {
  if (numericTokens(prompt).includes(token)) return true;
  return Object.entries(NUMBER_WORDS).some(
    ([word, number]) => number === token && new RegExp(`\\b${word}\\b`, 'i').test(prompt),
  );
}

function qualityIssues(
  testCase: EvalCase,
  suggestion: CoachSuggestionResult,
  fullPrompt: string,
): string[] {
  const issues: string[] = [];
  if (suggestion.hasSuggestion) {
    if (!suggestion.phrasing.trim()) issues.push('missing phrasing');
    if (!suggestion.headline.trim()) issues.push('missing headline');
    if (!suggestion.why.trim()) issues.push('missing rationale');
    if (words(suggestion.phrasing) > 32) issues.push('phrasing over 32 words');
    if (/\b(you should|i recommend|consider saying|tell the client|your answer)\b/i.test(suggestion.phrasing)) {
      issues.push('meta-coaching instead of say-aloud phrasing');
    }
    if (/\b(stupid|dumb|idiot|terrible answer|bad answer)\b/i.test(
      `${suggestion.headline} ${suggestion.phrasing} ${suggestion.why}`,
    )) {
      issues.push('shaming language');
    }
    const inventedNumbers = numericTokens(suggestion.phrasing)
      .filter((token) => !groundedNumber(token, fullPrompt));
    if (inventedNumbers.length > 0) issues.push(`invented number: ${inventedNumbers.join(', ')}`);
    const temporalMarkers = [
      'noon',
      'end of day',
      'tomorrow',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'saturday',
      'sunday',
    ];
    const inventedTimeline = temporalMarkers.find(
      (marker) => suggestion.phrasing.toLowerCase().includes(marker)
        && !fullPrompt.toLowerCase().includes(marker),
    );
    if (inventedTimeline) issues.push(`invented timeline: ${inventedTimeline}`);
  }
  if (suggestion.hasSuggestion !== testCase.expectedSuggestion) {
    issues.push('wrong intervention decision');
  }
  return issues;
}

function scoreCase(
  testCase: EvalCase,
  invocation: Invocation,
  rawError?: string,
): CaseResult {
  const fullPrompt = buildCoachPrompt(testCase.prompt);
  const parsed = parseCoachResult(invocation.raw);
  const suggestion = parsed.value;
  const decisionCorrect = suggestion?.hasSuggestion === testCase.expectedSuggestion;
  const incidentCorrect = Boolean(
    suggestion && testCase.acceptedIncidentTypes.includes(suggestion.incidentType),
  );
  const priorityConsistent = Boolean(suggestion && (
    testCase.expectedSuggestion ? suggestion.priority >= 4 : suggestion.priority < 4
  ));
  const issues = suggestion
    ? qualityIssues(testCase, suggestion, fullPrompt)
    : [parsed.error ?? rawError ?? 'unparseable output'];
  const qualityPass = Boolean(suggestion) && issues.length === 0;
  const withinDeadline = invocation.latencyMs <= ADVICE_DEADLINE_MS;
  const usable = decisionCorrect && incidentCorrect
    && priorityConsistent && qualityPass && withinDeadline;
  const score = (parsed.schemaValid ? 2 : 0)
    + (decisionCorrect ? 4 : 0)
    + (incidentCorrect ? 1 : 0)
    + (priorityConsistent ? 1 : 0)
    + (qualityPass ? 2 : 0);
  return {
    caseId: testCase.id,
    latencyMs: invocation.latencyMs,
    ttftMs: invocation.ttftMs,
    schemaValid: parsed.schemaValid,
    decisionCorrect,
    incidentCorrect,
    priorityConsistent,
    qualityPass,
    withinDeadline,
    usable,
    score,
    suggestion,
    issues,
    error: rawError ?? parsed.error,
    rawSnippet: invocation.raw.replace(/\s+/g, ' ').trim().slice(0, 400),
  };
}

class TerraProvider implements Provider {
  name = 'Responses API';
  model = COACH_MODEL;
  available = Boolean(process.env.OPENAI_API_KEY?.trim());
  skipReason = this.available ? undefined : 'OPENAI_API_KEY not configured';

  async invoke(_caseId: string, prompt: string): Promise<Invocation> {
    const startedAt = performance.now();
    const raw = await openaiStructuredJson(prompt, COACH_SYSTEM, COACH_SCHEMA, {
      model: this.model,
      reasoningEffort: 'none',
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: REQUEST_TIMEOUT_MS,
      label: 'coach-benchmark-terra',
    });
    return { raw, latencyMs: elapsed(startedAt), ttftMs: null };
  }
}

interface RealtimePending {
  caseId: string;
  startedAt: number;
  firstDeltaAt: number | null;
  responseId: string | null;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: Invocation): void;
  reject(error: Error): void;
}

class RealtimeProvider implements Provider {
  name: string;
  model = REALTIME_MODEL;
  available = Boolean(process.env.OPENAI_API_KEY?.trim());
  skipReason = this.available ? undefined : 'OPENAI_API_KEY not configured';
  connectMs?: number;

  private socket: OpenAIRealtimeWS | null = null;
  private pending: RealtimePending | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readonly effort: ReasoningEffort;

  constructor(effort: ReasoningEffort) {
    this.effort = effort;
    this.name = `Realtime mini (${effort})`;
  }

  async connect(): Promise<void> {
    const startedAt = performance.now();
    await new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      const timeout = setTimeout(
        () => this.failReady(new Error(`Realtime connect exceeded ${REQUEST_TIMEOUT_MS}ms`)),
        REQUEST_TIMEOUT_MS,
      );
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const socket = new OpenAIRealtimeWS({ model: this.model }, client);
      this.socket = socket;
      socket.on('error', (error) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (this.readyReject) this.failReady(failure);
        else this.failPending(failure);
      });
      socket.on('event', (event) => {
        const current = event as any;
        if (current.type === 'session.created') {
          socket.send({
            type: 'session.update',
            event_id: `benchmark-session-${this.effort}`,
            session: {
              type: 'realtime',
              output_modalities: ['text'],
              instructions: COACH_SYSTEM,
              max_output_tokens: REALTIME_MAX_OUTPUT_TOKENS,
              reasoning: { effort: this.effort },
            },
          } as any);
          return;
        }
        if (current.type === 'session.updated') {
          clearTimeout(timeout);
          this.connectMs = elapsed(startedAt);
          const done = this.readyResolve;
          this.readyResolve = null;
          this.readyReject = null;
          done?.();
          return;
        }
        this.handleEvent(current);
      });
    });
  }

  private failReady(error: Error): void {
    const reject = this.readyReject;
    this.readyResolve = null;
    this.readyReject = null;
    reject?.(error);
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.reject(error);
  }

  private handleEvent(event: any): void {
    const pending = this.pending;
    if (!pending) return;
    if (event.type === 'response.created') {
      pending.responseId = event.response?.id ?? null;
      return;
    }
    if (
      event.type === 'response.function_call_arguments.delta'
      || event.type === 'response.output_text.delta'
    ) {
      if (pending.firstDeltaAt === null) pending.firstDeltaAt = performance.now();
      return;
    }
    if (event.type !== 'response.done') return;
    const metadataCase = event.response?.metadata?.benchmark_case;
    if (metadataCase && metadataCase !== pending.caseId) return;
    clearTimeout(pending.timer);
    this.pending = null;
    const output = Array.isArray(event.response?.output) ? event.response.output : [];
    const functionCall = output.find((item: any) => item.type === 'function_call');
    let raw = typeof functionCall?.arguments === 'string' ? functionCall.arguments : '';
    if (!raw) {
      raw = output.flatMap((item: any) => Array.isArray(item.content) ? item.content : [])
        .map((part: any) => part.text ?? part.transcript ?? '')
        .join('');
    }
    if (event.response?.status !== 'completed') {
      pending.reject(new Error(
        `Realtime response ${event.response?.status ?? 'unknown'}: `
        + `${event.response?.status_details?.error?.message ?? event.response?.status_details?.reason ?? ''}`,
      ));
      return;
    }
    pending.resolve({
      raw,
      latencyMs: elapsed(pending.startedAt),
      ttftMs: pending.firstDeltaAt === null
        ? null
        : Math.round(pending.firstDeltaAt - pending.startedAt),
    });
  }

  async invoke(caseId: string, prompt: string): Promise<Invocation> {
    if (!this.socket) throw new Error('Realtime provider is not connected');
    if (this.pending) throw new Error('Realtime benchmark only supports one in-flight response');
    return new Promise<Invocation>((resolve, reject) => {
      const startedAt = performance.now();
      const timer = setTimeout(() => {
        const pending = this.pending;
        if (pending?.responseId) {
          this.socket?.send({
            type: 'response.cancel',
            response_id: pending.responseId,
          } as any);
        }
        this.failPending(new Error(`Realtime response exceeded ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending = {
        caseId,
        startedAt,
        firstDeltaAt: null,
        responseId: null,
        timer,
        resolve,
        reject,
      };
      this.socket!.send({
        type: 'response.create',
        event_id: `benchmark-${caseId}`,
        response: {
          conversation: 'none',
          metadata: { benchmark_case: caseId },
          output_modalities: ['text'],
          max_output_tokens: REALTIME_MAX_OUTPUT_TOKENS,
          input: [{
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: prompt }],
          }],
          tools: [{
            type: 'function',
            name: 'submit_coach_decision',
            description: 'Submit the single recovery-coach decision. Always call this function exactly once.',
            parameters: COACH_SCHEMA.schema,
          }],
          tool_choice: { type: 'function', name: 'submit_coach_decision' },
        },
      } as any);
    });
  }

  close(): void {
    this.socket?.close({ code: 1000, reason: 'benchmark complete' });
    this.socket = null;
  }
}

class DeepSeekProvider implements Provider {
  name: string;
  model = DEEPSEEK_MODEL;
  available = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
  skipReason = this.available ? undefined : 'DEEPSEEK_API_KEY not configured';

  constructor(private readonly strict: boolean) {
    this.name = strict ? 'DeepSeek V4 Flash (strict)' : 'DeepSeek V4 Flash (JSON)';
  }

  async invoke(_caseId: string, prompt: string): Promise<Invocation> {
    const baseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com')
      .replace(/\/+$/, '');
    const apiRoot = baseUrl.replace(/\/(?:beta|v1)$/, '');
    const endpoint = this.strict
      ? `${apiRoot}/beta/chat/completions`
      : `${baseUrl}/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const startedAt = performance.now();
    let firstDeltaAt: number | null = null;
    let raw = '';
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: COACH_SYSTEM },
            { role: 'user', content: prompt },
          ],
          thinking: { type: 'disabled' },
          ...(this.strict ? {
            tools: [{
              type: 'function',
              function: {
                name: 'submit_coach_decision',
                strict: true,
                description: 'Submit the single recovery-coach decision.',
                parameters: COACH_SCHEMA.schema,
              },
            }],
            tool_choice: {
              type: 'function',
              function: { name: 'submit_coach_decision' },
            },
          } : {
            response_format: { type: 'json_object' },
          }),
          max_tokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
          stream: true,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`DeepSeek HTTP ${response.status}: ${detail}`);
      }
      if (!response.body) throw new Error('DeepSeek response had no body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const consume = (block: string): void => {
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          const event = JSON.parse(data) as any;
          if (event.error) throw new Error(event.error.message ?? JSON.stringify(event.error));
          const choiceDelta = event.choices?.[0]?.delta;
          const delta = this.strict
            ? choiceDelta?.tool_calls?.[0]?.function?.arguments
            : choiceDelta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            if (firstDeltaAt === null) firstDeltaAt = performance.now();
            raw += delta;
          }
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          consume(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
        }
        if (done) break;
      }
      if (buffer.trim()) consume(buffer);
      return {
        raw,
        latencyMs: elapsed(startedAt),
        ttftMs: firstDeltaAt === null ? null : Math.round(firstDeltaAt - startedAt),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index]!;
}

function percent(count: number, total: number): string {
  return total === 0 ? '0%' : `${Math.round((count / total) * 100)}%`;
}

function providerSummary(result: ProviderResult): Record<string, string | number> {
  const total = result.cases.length;
  const latencies = result.cases.map((item) => item.latencyMs);
  const ttfts = result.cases.flatMap((item) => item.ttftMs === null ? [] : [item.ttftMs]);
  return {
    Provider: result.provider,
    Model: result.model,
    Score: `${result.cases.reduce((sum, item) => sum + item.score, 0)}/${total * 10}`,
    Decision: percent(result.cases.filter((item) => item.decisionCorrect).length, total),
    Schema: percent(result.cases.filter((item) => item.schemaValid).length, total),
    Quality: percent(result.cases.filter((item) => item.qualityPass).length, total),
    Usable: percent(result.cases.filter((item) => item.usable).length, total),
    'p50 ms': percentile(latencies, 0.5),
    'p95 ms': percentile(latencies, 0.95),
    'TTFT p50': ttfts.length ? percentile(ttfts, 0.5) : 'n/a',
    [`<${ADVICE_DEADLINE_MS / 1000}s`]: percent(
      result.cases.filter((item) => item.withinDeadline).length,
      total,
    ),
  };
}

async function runProvider(provider: Provider): Promise<ProviderResult> {
  if (provider.connect) await provider.connect();
  console.log(`\n${provider.name} · ${provider.model}`
    + (provider.connectMs === undefined ? '' : ` · connect ${provider.connectMs}ms`));
  await provider.invoke('warmup', WARMUP_PROMPT);
  const results: CaseResult[] = [];
  for (const testCase of selectedCases()) {
    try {
      const prompt = buildCoachPrompt(testCase.prompt);
      const invocation = await provider.invoke(testCase.id, prompt);
      const result = scoreCase(testCase, invocation);
      results.push(result);
      const mark = result.usable ? '✓' : result.decisionCorrect ? '△' : '✗';
      const advice = result.suggestion
        ? result.suggestion.hasSuggestion ? result.suggestion.phrasing : '(silent)'
        : `(unparseable: ${result.rawSnippet || 'empty'})`;
      console.log(
        `${mark} ${testCase.id.padEnd(25)} ${String(result.latencyMs).padStart(5)}ms`
        + ` · ${advice}${result.issues.length ? ` · ${result.issues.join('; ')}` : ''}`
        // A usable case can still miss the strict schema (the production
        // parser defaults the field). Name the field, or the Schema column
        // is a percentage nobody can act on.
        + (!result.schemaValid && result.error ? ` · ${result.error}` : ''),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = scoreCase(
        testCase,
        { raw: '', latencyMs: REQUEST_TIMEOUT_MS, ttftMs: null },
        message,
      );
      results.push(result);
      console.log(`✗ ${testCase.id.padEnd(25)} ERROR · ${message}`);
    }
  }
  provider.close?.();
  return {
    provider: provider.name,
    model: provider.model,
    connectMs: provider.connectMs,
    cases: results,
  };
}

async function main(): Promise<void> {
  resetLlmBudget();
  const cases = selectedCases();
  console.log(
    `Recovery coach benchmark: ${cases.length} frozen synthetic cases, `
    + `${ADVICE_DEADLINE_MS}ms usefulness deadline`,
  );
  console.log('No meeting audio or real transcript content is used.');

  const providers: Provider[] = [
    new TerraProvider(),
    new RealtimeProvider('minimal'),
    new RealtimeProvider('low'),
    new DeepSeekProvider(false),
    new DeepSeekProvider(true),
  ];
  const providerFilters = (process.env.COACH_EVAL_PROVIDER_FILTER || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const runnable = providers.filter((provider) => {
    if (
      providerFilters.length > 0
      && !providerFilters.some((filter) => provider.name.toLowerCase().includes(filter))
    ) {
      return false;
    }
    if (provider.available) return true;
    console.log(`SKIP ${provider.name}: ${provider.skipReason}`);
    return false;
  });
  const results: ProviderResult[] = [];
  for (const provider of runnable) {
    try {
      results.push(await runProvider(provider));
    } catch (error) {
      provider.close?.();
      console.log(
        `\nFAILED ${provider.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.log('\nSummary');
  console.table(results.map(providerSummary));
  if (results.length === 0) process.exitCode = 1;
}

function selectedCases(): EvalCase[] {
  const filters = (process.env.COACH_EVAL_CASE_FILTER || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (filters.length === 0) return CASES;
  const selected = CASES.filter((testCase) => filters.includes(testCase.id));
  if (selected.length === 0) {
    throw new Error(`COACH_EVAL_CASE_FILTER matched no cases: ${filters.join(', ')}`);
  }
  return selected;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
