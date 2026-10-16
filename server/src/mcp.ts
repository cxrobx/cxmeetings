/**
 * Meeting Copilot as a stdio MCP server, so an outside agent (QuickAsk, Claude
 * Code) can drive the live meeting.
 *
 * A THIN CLIENT of the running copilot server: every tool is one request to it
 * (HTTP for reads, the WebSocket for actions) and the answer is the one the
 * copilot's own warm sessions produce for its own UI. This process never calls
 * a model, so a question costs what the menu bar's Ask box costs, and its
 * answer lands in the dashboard too.
 *
 * Connection: the owner-only Unix socket (~/.meeting-copilot/copilot.sock,
 * 0600) first, then 127.0.0.1:COPILOT_PORT (17890). Neither has auth or an
 * origin check; the socket is preferred because only this user can open it.
 *
 * Correlation: requests carry a `requestId`, and the server answers it on this
 * socket alone (`request.ack`, and `request.result` for pulse and suggest; see
 * "Request correlation" in index.ts), so another client asking at the same
 * moment can't hand us its answer. A server built before that change sends no
 * ack; then answers are matched by what they look like (the question's text,
 * the card title, the ask kind), which is right unless two clients ask the
 * same thing at the same moment. structuredContent.correlated says which.
 *
 * Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout (initialize,
 * notifications/*, ping, tools/list, tools/call). Logs go to stderr only.
 *
 *   node server/dist/mcp.js          (or bin/meeting-copilot-mcp)
 *   env: MEETING_COPILOT_SOCKET  socket path ('none' = TCP only)
 *        COPILOT_PORT            TCP port (default 17890)
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// ─── Endpoint ────────────────────────────────────────────────────────────────

export interface Endpoint {
  /** The server's Unix socket, or null for TCP only. */
  socketPath: string | null;
  port: number;
}

export function endpointFromEnv(env: NodeJS.ProcessEnv = process.env): Endpoint {
  const named = env.MEETING_COPILOT_SOCKET;
  const socketPath = named === 'none' || named === '' ? null : named || join(homedir(), '.meeting-copilot', 'copilot.sock');
  const port = Number.parseInt(env.COPILOT_PORT || '17890', 10);
  return { socketPath, port: Number.isFinite(port) ? port : 17890 };
}

type Via = 'socket' | 'tcp';

function describe(ep: Endpoint): string {
  return ep.socketPath ? `${ep.socketPath} or 127.0.0.1:${ep.port}` : `127.0.0.1:${ep.port}`;
}

export class ServerDownError extends Error {}
export class NotLiveError extends Error {}

export const NO_MEETING = 'No meeting is live in Meeting Copilot.';

function viaOrder(ep: Endpoint): Via[] {
  return ep.socketPath && existsSync(ep.socketPath) ? ['socket', 'tcp'] : ['tcp'];
}

function getJsonVia(ep: Endpoint, via: Via, path: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      via === 'socket' ? { socketPath: ep.socketPath!, path, method: 'GET' } : { host: '127.0.0.1', port: ep.port, path, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) return reject(new Error(`HTTP ${res.statusCode} from ${path}`));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error(`Unreadable reply from ${path}`));
          }
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`No reply from ${path} within ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

/** GET a JSON route: the socket first, then TCP. Throws ServerDownError when neither answers. */
export async function getJson(ep: Endpoint, path: string, timeoutMs = 4_000): Promise<{ json: any; via: Via }> {
  const errors: string[] = [];
  for (const via of viaOrder(ep)) {
    try {
      return { json: await getJsonVia(ep, via, path, timeoutMs), via };
    } catch (err) {
      errors.push(`${via}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new ServerDownError(
    `Meeting Copilot isn't running: its server didn't answer at ${describe(ep)} (${errors.join('; ')}). Open Meeting Copilot and try again.`,
  );
}

// ─── WebSocket connection ────────────────────────────────────────────────────

type Msg = Record<string, any>;

class Conn {
  private listeners = new Set<(m: Msg) => void>();
  private closedReason: string | null = null;
  private closeListeners = new Set<(reason: string) => void>();

  constructor(private ws: WebSocket, readonly hello: Msg) {
    ws.on('message', (raw) => {
      let m: Msg;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      for (const fn of [...this.listeners]) fn(m);
    });
    const closed = (reason: string) => {
      if (this.closedReason) return;
      this.closedReason = reason;
      for (const fn of [...this.closeListeners]) fn(reason);
    };
    ws.on('close', () => closed('The copilot server closed the connection'));
    ws.on('error', (e) => closed(`Connection error: ${e.message}`));
  }

  on(fn: (m: Msg) => void): void {
    this.listeners.add(fn);
  }

  onClose(fn: (reason: string) => void): void {
    if (this.closedReason) fn(this.closedReason);
    else this.closeListeners.add(fn);
  }

  send(m: Msg): void {
    this.ws.send(JSON.stringify(m));
  }

  close(): void {
    this.listeners.clear();
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

function openVia(ep: Endpoint, via: Via, timeoutMs: number): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const url = via === 'socket' ? `ws+unix://${ep.socketPath}:/` : `ws://127.0.0.1:${ep.port}/`;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`no hello within ${timeoutMs} ms`));
    }, timeoutMs);
    const early: Msg[] = [];
    const onMessage = (raw: WebSocket.RawData) => {
      let m: Msg;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.type !== 'session.state') {
        early.push(m);
        return;
      }
      // The server's first message on connect is the session state.
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(new Conn(ws, m));
    };
    ws.on('message', onMessage);
    ws.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ws.once('close', () => {
      clearTimeout(timer);
      reject(new Error('closed before hello'));
    });
  });
}

export async function connect(ep: Endpoint, timeoutMs = 4_000): Promise<Conn> {
  const errors: string[] = [];
  for (const via of viaOrder(ep)) {
    try {
      return await openVia(ep, via, timeoutMs);
    } catch (err) {
      errors.push(`${via}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new ServerDownError(
    `Meeting Copilot isn't running: couldn't open its live connection at ${describe(ep)} (${errors.join('; ')}). Open Meeting Copilot and try again.`,
  );
}

// ─── Tool plumbing ───────────────────────────────────────────────────────────

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function ok(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function fail(text: string, structured: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: { error: text, ...structured }, isError: true };
}

export interface ToolOptions {
  endpoint?: Endpoint;
  /** Overrides for the per-tool deadlines (ms), for tests. */
  timeouts?: Partial<Record<'ask' | 'pulse' | 'suggest' | 'research' | 'connect' | 'ackGrace', number>>;
  now?: () => number;
}

const DEFAULT_TIMEOUTS = { ask: 90_000, pulse: 120_000, suggest: 90_000, research: 90_000, connect: 4_000, ackGrace: 1_500 };

function timeoutsOf(opts: ToolOptions) {
  return { ...DEFAULT_TIMEOUTS, ...(opts.timeouts ?? {}) };
}

/** The live session from /health, or a NotLiveError. */
async function requireLive(ep: Endpoint, connectMs: number): Promise<string> {
  const { json } = await getJson(ep, '/health', connectMs);
  if (!json || typeof json.session !== 'string' || !json.session) throw new NotLiveError(NO_MEETING);
  return json.session;
}

function errorResult(err: unknown): ToolResult {
  if (err instanceof NotLiveError) return fail(NO_MEETING, { live: false });
  if (err instanceof ServerDownError) return fail(err.message, { serverDown: true });
  return fail(`Meeting Copilot request failed: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * Waits for the server's ack to a requestId, or — when the server predates
 * requestIds and never acks — accepts a match found by looking at the
 * broadcasts, once the ack grace has passed without an ack.
 */
class Correlation<T> {
  ackReceived = false;
  private settled = false;
  private resolveFn!: (v: { value: T; correlated: 'requestId' | 'heuristic' } | { error: string }) => void;
  readonly done: Promise<{ value: T; correlated: 'requestId' | 'heuristic' } | { error: string }>;

  constructor(private sentAt: () => number, private graceMs: number, private now: () => number) {
    this.done = new Promise((r) => { this.resolveFn = r; });
  }

  ack(): void {
    this.ackReceived = true;
  }

  byRequestId(value: T): void {
    this.ackReceived = true;
    this.settle({ value, correlated: 'requestId' });
  }

  fail(error: string): void {
    this.settle({ error });
  }

  byHeuristic(value: T): void {
    if (this.ackReceived || this.settled) return;
    const wait = Math.max(0, this.graceMs - (this.now() - this.sentAt()));
    setTimeout(() => {
      if (!this.ackReceived) this.settle({ value, correlated: 'heuristic' });
    }, wait);
  }

  private settle(v: { value: T; correlated: 'requestId' | 'heuristic' } | { error: string }): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveFn(v);
  }
}

function deadline<T>(ms: number): { promise: Promise<'timeout'>; cancel: () => void } {
  let timer: NodeJS.Timeout;
  const promise = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), ms); });
  return { promise, cancel: () => clearTimeout(timer) };
}

function closedPromise(conn: Conn): Promise<{ closed: string }> {
  return new Promise((r) => conn.onClose((reason) => r({ closed: reason })));
}

function secs(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

// ─── Tools ───────────────────────────────────────────────────────────────────

export async function toolStatus(_args: Msg, opts: ToolOptions = {}): Promise<ToolResult> {
  const ep = opts.endpoint ?? endpointFromEnv();
  const t = timeoutsOf(opts);
  const now = opts.now ?? Date.now;
  try {
    const { json: health, via } = await getJson(ep, '/health', t.connect);
    const live = typeof health?.session === 'string' && !!health.session;
    let hello: Msg | null = null;
    try {
      const conn = await connect(ep, t.connect);
      hello = conn.hello;
      conn.close();
    } catch {
      /* health alone still answers */
    }
    const state: string = hello?.state ?? (live ? 'live' : 'idle');
    const startedAt = typeof hello?.startedAt === 'number' ? hello.startedAt : null;
    const elapsedMinutes = live && startedAt ? Math.max(0, Math.round((now() - startedAt) / 60_000)) : null;
    const title: string | null = live ? hello?.title ?? null : null;
    const structured = {
      live,
      sessionId: live ? health.session : null,
      title,
      state,
      startedAt: live && startedAt ? new Date(startedAt).toISOString() : null,
      elapsedMinutes,
      connectedVia: via,
    };
    const text = live
      ? `Meeting live${title ? `: "${title}"` : ''} — ${elapsedMinutes ?? '?'} min in (state ${state}, session ${health.session}).`
      : `${NO_MEETING} (state ${state})`;
    return ok(text, structured);
  } catch (err) {
    return errorResult(err);
  }
}

export async function toolTranscript(args: Msg, opts: ToolOptions = {}): Promise<ToolResult> {
  const ep = opts.endpoint ?? endpointFromEnv();
  const t = timeoutsOf(opts);
  const now = opts.now ?? Date.now;
  const minutes = typeof args.minutes === 'number' && args.minutes > 0 ? args.minutes : 10;
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : null;
  try {
    await requireLive(ep, t.connect);
    const { json } = await getJson(ep, '/transcript', t.connect);
    if (!json?.active) return fail(NO_MEETING, { live: false });
    const all: Msg[] = Array.isArray(json.segments) ? json.segments : [];
    const since = now() - minutes * 60_000;
    let segments = all.filter((s) => typeof s.timestamp !== 'number' || s.timestamp >= since);
    if (limit) segments = segments.slice(-limit);
    const lines = segments.map((s) => `${s.label || s.source || 'unknown'}: ${String(s.text ?? '').trim()}`);
    const text = lines.length ? lines.join('\n') : `Nothing was said in the last ${minutes} minutes.`;
    return ok(text, {
      sessionId: json.sessionId ?? null,
      minutes,
      count: segments.length,
      totalSegments: all.length,
      segments: segments.map((s) => ({
        speaker: s.label || s.source,
        source: s.source,
        text: s.text,
        timestamp: typeof s.timestamp === 'number' ? new Date(s.timestamp).toISOString() : s.timestamp,
      })),
    });
  } catch (err) {
    return errorResult(err);
  }
}

export async function toolAsk(args: Msg, opts: ToolOptions = {}): Promise<ToolResult> {
  const question = typeof args.question === 'string' ? args.question.trim() : '';
  if (!question) return fail('ask needs a question.');
  const ep = opts.endpoint ?? endpointFromEnv();
  const t = timeoutsOf(opts);
  const now = opts.now ?? Date.now;
  const started = now();
  let conn: Conn | null = null;
  try {
    const sessionId = await requireLive(ep, t.connect);
    conn = await connect(ep, t.connect);
    const requestId = randomUUID();
    const sentText = question.slice(0, 4_000);
    let sentAt = now();
    const corr = new Correlation<string>(() => sentAt, t.ackGrace, now);
    // Everything about every answer, since we may learn our id after its events.
    const streamed = new Map<string, { seqs: Set<number>; text: string }>();
    const finals = new Map<string, Msg>();
    let pendingUserMatch = false;
    let finalWaiter: ((m: Msg) => void) | null = null;
    let targetId: string | null = null;
    conn.on((m) => {
      if (m.type === 'request.ack' && m.requestId === requestId) {
        if (m.ok === false) corr.fail(String(m.error || 'The copilot refused the question'));
        else if (m.assistantMessageId) corr.byRequestId(String(m.assistantMessageId));
        else corr.ack();
        return;
      }
      if (m.type === 'chat.delta' && typeof m.id === 'string') {
        const s = streamed.get(m.id) ?? { seqs: new Set<number>(), text: '' };
        if (!s.seqs.has(m.seq)) {
          s.seqs.add(m.seq);
          s.text += String(m.text ?? '');
        }
        streamed.set(m.id, s);
        return;
      }
      if (m.type === 'chat.message' && m.message) {
        const msg = m.message as Msg;
        if (msg.role === 'user' && msg.content === sentText && msg.origin === 'menubar') pendingUserMatch = true;
        else if (msg.role === 'assistant' && msg.state === 'streaming' && pendingUserMatch) {
          // The server emits the question and its answer's placeholder back to back.
          pendingUserMatch = false;
          corr.byHeuristic(String(msg.id));
        }
        if (msg.role === 'assistant' && msg.state !== 'streaming') {
          finals.set(String(msg.id), msg);
          if (targetId === msg.id) finalWaiter?.(msg);
        }
      }
    });
    const closed = closedPromise(conn);
    conn.send({ type: 'chat.send', text: question, origin: 'menubar', requestId });
    sentAt = now();
    const budget = t.ask - (now() - started);
    const dl = deadline(Math.max(0, budget));
    const first = await Promise.race([corr.done, dl.promise, closed]);
    if (first === 'timeout') return fail(`The copilot didn't take the question within ${secs(t.ask)}.`, { question });
    if ('closed' in first) { dl.cancel(); return fail(`${first.closed} before the answer came back.`, { question }); }
    if ('error' in first) {
      dl.cancel();
      return /no meeting is live/i.test(first.error) ? fail(NO_MEETING, { live: false }) : fail(`The copilot couldn't ask: ${first.error}`, { question });
    }
    targetId = first.value;
    const finalMsg: Msg | 'timeout' | { closed: string } = finals.get(targetId) ?? await Promise.race([
      new Promise<Msg>((r) => { finalWaiter = r; }),
      dl.promise,
      closed,
    ]);
    dl.cancel();
    const partial = streamed.get(targetId)?.text ?? '';
    const base = { sessionId, question, messageId: targetId, correlated: first.correlated };
    if (finalMsg === 'timeout' || 'closed' in finalMsg) {
      const why = finalMsg === 'timeout' ? `No complete answer within ${secs(t.ask)}` : String((finalMsg as { closed: string }).closed);
      return fail(
        `${why}; the answer is still being written in Meeting Copilot's chat.${partial ? `\n\nSo far:\n${partial}` : ''}`,
        { ...base, answer: partial, state: 'streaming', timedOut: finalMsg === 'timeout' },
      );
    }
    const answer = String(finalMsg.content ?? '');
    if (finalMsg.state !== 'done') {
      return fail(
        `The copilot's answer ${finalMsg.state === 'cancelled' ? 'was cancelled' : `failed: ${finalMsg.error || 'unknown error'}`}.${answer ? `\n\n${answer}` : ''}`,
        { ...base, answer, state: finalMsg.state },
      );
    }
    return ok(answer, { ...base, answer, state: 'done', via: finalMsg.via ?? null });
  } catch (err) {
    return errorResult(err);
  } finally {
    conn?.close();
  }
}

const PULSE_TRIGGER: Record<string, string> = { checkin: 'check-in', missed: 'missed', wrapup: 'manual' };

function formatPulse(title: string | undefined, body: string | undefined, p: Msg | null): string {
  const out: string[] = [];
  if (title) out.push(title);
  if (body) out.push(body);
  if (p) {
    if (p.read && p.read !== body) out.push(`Read: ${p.read}`);
    const list = (label: string, items: unknown) => {
      if (Array.isArray(items) && items.length) out.push(`${label}:\n${items.map((i: Msg) => `- ${i.text}`).join('\n')}`);
    };
    list('Escalate', p.escalations);
    list('Settle before the end', p.closeOut);
    list('Missed', p.missed);
    const meta = [p.status ? `status ${p.status}` : '', typeof p.minutesIn === 'number' ? `${p.minutesIn} min in` : '', typeof p.minutesLeft === 'number' ? `${p.minutesLeft} min left` : '']
      .filter(Boolean)
      .join(' · ');
    if (meta) out.push(`(${meta})`);
  }
  return out.join('\n\n');
}

export async function toolPulse(args: Msg, opts: ToolOptions = {}): Promise<ToolResult> {
  const kind = args.kind === 'checkin' || args.kind === 'missed' || args.kind === 'wrapup' ? args.kind : null;
  if (!kind) return fail('pulse needs kind: "checkin", "missed" or "wrapup".');
  const ep = opts.endpoint ?? endpointFromEnv();
  const t = timeoutsOf(opts);
  const now = opts.now ?? Date.now;
  const started = now();
  let conn: Conn | null = null;
  try {
    const sessionId = await requireLive(ep, t.connect);
    conn = await connect(ep, t.connect);
    const requestId = randomUUID();
    let sentAt = now();
    type PulseOut = { ok: boolean; title?: string; body?: string; pulse: Msg | null; error?: string };
    const corr = new Correlation<PulseOut>(() => sentAt, t.ackGrace, now);
    let lastPulse: Msg | null = null;
    conn.on((m) => {
      if (m.requestId === requestId) {
        if (m.type === 'request.ack') {
          if (m.ok === false) corr.fail(String(m.error || 'The copilot refused the read'));
          else corr.ack();
        } else if (m.type === 'request.result') {
          corr.byRequestId({ ok: m.ok !== false, title: m.title, body: m.body, pulse: m.pulse ?? null, error: m.error });
        }
        return;
      }
      if (m.type === 'pulse.update' && m.pulse?.trigger === PULSE_TRIGGER[kind]) lastPulse = m.pulse;
      if (m.type === 'ask.state' && m.kind === kind && (m.phase === 'done' || m.phase === 'failed')) {
        corr.byHeuristic(m.phase === 'done'
          ? { ok: true, title: m.title, body: m.body, pulse: lastPulse }
          : { ok: false, title: m.title, body: m.body, pulse: null, error: m.body || m.title });
      }
    });
    const closed = closedPromise(conn);
    conn.send({ type: 'pulse.request', kind: kind === 'wrapup' ? 'closeout' : kind, requestId });
    sentAt = now();
    const dl = deadline(Math.max(0, t.pulse - (now() - started)));
    const r = await Promise.race([corr.done, dl.promise, closed]);
    dl.cancel();
    if (r === 'timeout') return fail(`The ${kind} read didn't come back within ${secs(t.pulse)}; it may still appear in Meeting Copilot.`, { sessionId, kind, timedOut: true });
    if ('closed' in r) return fail(`${r.closed} before the ${kind} read came back.`, { sessionId, kind });
    if ('error' in r) return /no meeting is live/i.test(r.error) ? fail(NO_MEETING, { live: false }) : fail(`The ${kind} read didn't run: ${r.error}`, { sessionId, kind });
    const v = r.value;
    if (!v.ok) return fail(`The ${kind} read failed: ${v.error || 'unknown error'}`, { sessionId, kind, correlated: r.correlated });
    return ok(formatPulse(v.title, v.body, v.pulse), { sessionId, kind, title: v.title ?? null, body: v.body ?? null, pulse: v.pulse, correlated: r.correlated });
  } catch (err) {
    return errorResult(err);
  } finally {
    conn?.close();
  }
}

export async function toolSuggest(args: Msg, opts: ToolOptions = {}): Promise<ToolResult> {
  const focus = typeof args.focus === 'string' ? args.focus.trim() : '';
  const ep = opts.endpoint ?? endpointFromEnv();
  const t = timeoutsOf(opts);
  const now = opts.now ?? Date.now;
  const started = now();
  let conn: Conn | null = null;
  try {
    const sessionId = await requireLive(ep, t.connect);
    conn = await connect(ep, t.connect);
    const requestId = randomUUID();
    let sentAt = now();
    type SuggestOut = { ok: boolean; suggestion: Msg | null; title?: string; body?: string; empty?: boolean; error?: string };
    const corr = new Correlation<SuggestOut>(() => sentAt, t.ackGrace, now);
    let lastSuggestion: Msg | null = null;
    conn.on((m) => {
      if (m.requestId === requestId) {
        if (m.type === 'request.ack') {
          if (m.ok === false) corr.fail(String(m.error || 'The copilot refused the request'));
          else corr.ack();
        } else if (m.type === 'request.result') {
          corr.byRequestId({ ok: m.ok !== false, suggestion: m.suggestion ?? null, title: m.title, body: m.body, empty: m.empty, error: m.error });
        }
        return;
      }
      if (m.type === 'coach.suggestion' && m.suggestion) lastSuggestion = m.suggestion;
      if (m.type === 'ask.state' && m.kind === 'suggest' && (m.phase === 'done' || m.phase === 'failed')) {
        corr.byHeuristic(m.phase === 'done'
          ? { ok: true, suggestion: m.empty ? null : lastSuggestion, title: m.title, body: m.body, empty: m.empty }
          : { ok: false, suggestion: null, error: m.body || m.title });
      }
    });
    const closed = closedPromise(conn);
    conn.send({ type: 'coach.ask', focus, requestId });
    sentAt = now();
    const dl = deadline(Math.max(0, t.suggest - (now() - started)));
    const r = await Promise.race([corr.done, dl.promise, closed]);
    dl.cancel();
    if (r === 'timeout') return fail(`No suggestion came back within ${secs(t.suggest)}; it may still appear in Meeting Copilot.`, { sessionId, focus, timedOut: true });
    if ('closed' in r) return fail(`${r.closed} before the suggestion came back.`, { sessionId, focus });
    if ('error' in r) return /no meeting is live/i.test(r.error) ? fail(NO_MEETING, { live: false }) : fail(`Suggest didn't run: ${r.error}`, { sessionId, focus });
    const v = r.value;
    if (!v.ok) return fail(`Suggest failed: ${v.error || 'unknown error'}`, { sessionId, focus, correlated: r.correlated });
    const s = v.suggestion;
    if (!s || v.empty) {
      return ok('Nothing worth saying right now.', { sessionId, focus, empty: true, suggestion: null, correlated: r.correlated });
    }
    const text = [s.headline || v.title, s.phrasing ? `Say: ${s.phrasing}` : v.body, s.why ? `Why: ${s.why}` : '']
      .filter(Boolean)
      .join('\n\n');
    return ok(text, { sessionId, focus, empty: false, suggestion: s, correlated: r.correlated });
  } catch (err) {
    return errorResult(err);
  } finally {
    conn?.close();
  }
}

const TERMINAL_ACTION_STATES = new Set(['completed', 'failed', 'cancelled', 'expired']);

function resultText(result: Msg | undefined): string {
  if (!result) return '';
  const artifact = Array.isArray(result.artifacts) ? result.artifacts.find((a: Msg) => typeof a?.content === 'string' && a.content) : null;
  return String(artifact?.content ?? result.data?.findings ?? result.data?.answer ?? result.summary ?? '');
}

export async function toolResearch(args: Msg, opts: ToolOptions = {}): Promise<ToolResult> {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) return fail('research needs a prompt.');
  const actionType = args.fast === true ? 'fast-research' : 'research';
  const ep = opts.endpoint ?? endpointFromEnv();
  const t = timeoutsOf(opts);
  const now = opts.now ?? Date.now;
  const started = now();
  let conn: Conn | null = null;
  try {
    const sessionId = await requireLive(ep, t.connect);
    conn = await connect(ep, t.connect);
    const requestId = randomUUID();
    let sentAt = now();
    const corr = new Correlation<string>(() => sentAt, t.ackGrace, now);
    // The title index.ts gives a manual card: "<Type>: <prompt>".
    const expectedTitle = `${actionType.charAt(0).toUpperCase()}${actionType.slice(1)}: ${prompt}`;
    const streamed = new Map<string, string>();
    const finals = new Map<string, Msg>();
    let targetId: string | null = null;
    let finalWaiter: ((m: Msg) => void) | null = null;
    conn.on((m) => {
      if (m.type === 'request.ack' && m.requestId === requestId) {
        if (m.ok === false) corr.fail(String(m.error || 'The copilot refused the request'));
        else if (m.actionId) corr.byRequestId(String(m.actionId));
        else corr.ack();
        return;
      }
      if (m.type === 'action.suggested' && m.action?.type === actionType && m.action?.title === expectedTitle) {
        corr.byHeuristic(String(m.action.id));
        return;
      }
      if (m.type === 'action.stream' && typeof m.actionId === 'string') {
        streamed.set(m.actionId, (streamed.get(m.actionId) ?? '') + String(m.delta ?? ''));
        return;
      }
      if (m.type === 'action.status' && TERMINAL_ACTION_STATES.has(m.state)) {
        finals.set(String(m.actionId), m);
        if (targetId === m.actionId) finalWaiter?.(m);
      }
    });
    const closed = closedPromise(conn);
    conn.send({ type: 'action.trigger', actionType, prompt, requestId });
    sentAt = now();
    const dl = deadline(Math.max(0, t.research - (now() - started)));
    const first = await Promise.race([corr.done, dl.promise, closed]);
    if (first === 'timeout') return fail(`The copilot didn't start the research within ${secs(t.research)}.`, { prompt, actionType });
    if ('closed' in first) { dl.cancel(); return fail(`${first.closed} before the research started.`, { prompt, actionType }); }
    if ('error' in first) {
      dl.cancel();
      return /no meeting is live/i.test(first.error) ? fail(NO_MEETING, { live: false }) : fail(`The copilot didn't start the research: ${first.error}`, { prompt, actionType });
    }
    const actionId = first.value;
    targetId = actionId;
    const fin: Msg | 'timeout' | { closed: string } = finals.get(actionId) ?? await Promise.race([
      new Promise<Msg>((r) => { finalWaiter = r; }),
      dl.promise,
      closed,
    ]);
    dl.cancel();
    const partial = streamed.get(actionId) ?? '';
    const base = { sessionId, prompt, actionType, actionId, correlated: first.correlated };
    if (fin === 'timeout' || 'closed' in fin) {
      const why = fin === 'timeout' ? `Not finished after ${secs(t.research)}` : (fin as { closed: string }).closed;
      const note = `${why}: the research is still running in Meeting Copilot (action ${actionId}); its card will show the finished answer.`;
      return ok(partial ? `${partial}\n\n— ${note}` : note, { ...base, state: 'running', timedOut: fin === 'timeout', partial });
    }
    const text = resultText(fin.result) || partial;
    if (fin.state !== 'completed' || fin.result?.success === false) {
      const why = fin.result?.error || fin.result?.summary || fin.state;
      return fail(`The research ${fin.state === 'completed' ? 'failed' : fin.state}: ${why}`, { ...base, state: fin.state, result: fin.result ?? null });
    }
    return ok(text, { ...base, state: 'completed', result: fin.result ?? null });
  } catch (err) {
    return errorResult(err);
  } finally {
    conn?.close();
  }
}

// ─── MCP surface ─────────────────────────────────────────────────────────────

export const TOOLS = [
  {
    name: 'status',
    description: 'Is a meeting live in Meeting Copilot? Returns the session id, title, state, start time and minutes elapsed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'transcript',
    description: 'The live meeting\'s recent transcript as "speaker: text" lines.',
    inputSchema: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'How far back to read, in minutes (default 10).' },
        limit: { type: 'number', description: 'At most this many segments (the most recent).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ask',
    description: 'Ask the meeting copilot a question in the live meeting\'s chat. It answers with the whole meeting as context (and web search), and the answer also shows in the copilot. Waits up to 90 s for the full answer.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string', description: 'The question.' } },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'pulse',
    description: 'A read of the live meeting: "checkin" = how am I doing?, "missed" = did I miss anything?, "wrapup" = what to settle before the end. Takes about 30 s; waits up to 120 s.',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['checkin', 'missed', 'wrapup'] } },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'suggest',
    description: 'One coaching suggestion for right now in the live meeting (what to say next), optionally about a focus. Waits up to 90 s.',
    inputSchema: {
      type: 'object',
      properties: { focus: { type: 'string', description: 'Optional: what the suggestion should be about.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'research',
    description: 'Research a question in the context of the live meeting; the result also appears as a card in the copilot. fast=true for the quick web answer only. Waits up to 90 s, then returns what has streamed so far and leaves it running.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to research.' },
        fast: { type: 'boolean', description: 'Fast research (quick web answer) instead of the full research card.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
] as const;

const HANDLERS: Record<string, (args: Msg, opts: ToolOptions) => Promise<ToolResult>> = {
  status: toolStatus,
  transcript: toolTranscript,
  ask: toolAsk,
  pulse: toolPulse,
  suggest: toolSuggest,
  research: toolResearch,
};

export async function callTool(name: string, args: Msg, opts: ToolOptions = {}): Promise<ToolResult> {
  const handler = HANDLERS[name];
  if (!handler) return fail(`Unknown tool: ${name}`);
  return handler(args ?? {}, opts);
}

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function serverVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, '..', '..', 'VERSION'), 'utf8').trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** One JSON-RPC message in, zero or one out. */
export async function handleRpc(msg: Msg, opts: ToolOptions = {}): Promise<Msg | null> {
  const id = msg?.id;
  const isRequest = id !== undefined && id !== null;
  const method = msg?.method;
  if (typeof method !== 'string') {
    return isRequest ? { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } } : null;
  }
  if (!isRequest) return null; // notifications/initialized and friends
  switch (method) {
    case 'initialize': {
      const requested = msg.params?.protocolVersion;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'meeting-copilot', version: serverVersion() },
          instructions: 'Drives the live meeting in Meeting Copilot (a thin client of the running app). Start with status. Every answer also shows in the copilot\'s own panel.',
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const name = msg.params?.name;
      if (typeof name !== 'string' || !HANDLERS[name]) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${String(name)}` } };
      }
      const result = await callTool(name, msg.params?.arguments ?? {}, opts);
      return { jsonrpc: '2.0', id, result };
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

export function runStdio(opts: ToolOptions = {}): void {
  let pending = 0;
  let inputClosed = false;
  const write = (m: Msg) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const maybeExit = () => {
    if (inputClosed && pending === 0) process.exit(0);
  };
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    pending++;
    handleRpc(msg, opts)
      .then((reply) => { if (reply) write(reply); })
      .catch((err) => {
        process.stderr.write(`[meeting-copilot-mcp] ${err instanceof Error ? err.stack : String(err)}\n`);
        if (msg?.id !== undefined && msg?.id !== null) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } });
      })
      .finally(() => { pending--; maybeExit(); });
  });
  rl.on('close', () => { inputClosed = true; maybeExit(); });
}

const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (invokedDirectly) runStdio();
