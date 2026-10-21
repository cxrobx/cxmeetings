import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { ContextDoc } from '../context/index.js';
import { parseFirstJsonObject } from '../intelligence/first-json.js';
import { runLiveJson, type LiveJsonSchema } from '../intelligence/live-json.js';
import { MODEL_CONFIG } from '../model-config.js';
import type { TranscriptRecord } from '../session/store.js';

/**
 * The call bridge: cxventures.io/call tells the copilot which business is on
 * the line, and later asks it to draft that call's log.
 *
 * A calling block is ONE copilot session with many short calls in it. Each
 * dial swaps in that business's script and leaves a `[Calling]` row in the
 * transcript, so the coach, the suggestions and the chat all know where one
 * call ends and the next begins.
 *
 * The page talks to this from the browser (components/call/copilot.ts in the
 * cxventures repo), so these are the only routes on this server that answer a
 * cross-origin request, and only from the origins below. Nothing else here has
 * an origin check (mcp.ts says so), which is fine for a server only this user's
 * processes can reach, but a web page in any tab can reach 127.0.0.1 too: a
 * request carrying any other Origin gets a 403 before it touches the session.
 *
 * State lives in one CallBridge, reset at every session start and stop
 * (invariant #2: nothing outlives its session).
 */

export const CALL_BRIDGE_ORIGINS: readonly string[] = [
  'https://cxventures.io',
  'http://localhost:3600',
  'http://127.0.0.1:3600',
];

export const CALL_MARKER_LABEL = '[Calling]';
/** The pinned doc's relativePath: one per session, replaced on every dial. */
export const CALL_SCRIPT_DOC_PATH = 'call-script';
/** Scripts measured 7.3–8.5k characters (2026-10-20); the cap only stops a runaway. */
const SCRIPT_MAX_CHARS = 12_000;
const DRAFT_TRANSCRIPT_MAX_CHARS = 20_000;

export interface CallOnLine {
  companyId: string;
  companyName: string;
  phone: string;
  pitch: string;
  script: string;
  startedAt: number;
}

export interface DialInput {
  companyId: string;
  companyName: string;
  phone: string;
  pitch: string;
  script: string;
}

export interface DraftOutcome {
  id: string;
  label: string;
}

export interface CallDraft {
  outcome: string | null;
  said: string;
  notes: string;
  words: number;
}

export class CallBridge {
  private current: CallOnLine | null = null;

  get calling(): CallOnLine | null {
    return this.current;
  }

  reset(): void {
    this.current = null;
  }

  dial(input: DialInput, now: number): CallOnLine {
    this.current = { ...input, startedAt: now };
    return this.current;
  }

  /**
   * The private goals as the coach and the chat read them: the user's own,
   * then the call on the line and its script. With no call, exactly the
   * user's goals, so a normal meeting is unchanged.
   */
  goalsWith(meetingGoals: string, now: number = Date.now()): string {
    const call = this.current;
    if (!call) return meetingGoals;
    const minutes = Math.max(0, Math.round((now - call.startedAt) / 60_000));
    const lines = [
      `ON THE PHONE NOW: ${call.companyName} (${call.pitch.replace(/_/g, ' ')} pitch), dialed ${minutes} min ago.`,
      'This is a cold call and the user is reading the script below; the other party is the meeting track.',
      'Coach against the script: the next line to say, the script\'s own answer when they push back, a "Don\'t say" line the user just broke, and the ask (the script\'s yes) when the moment is there.',
      'Everything before the latest "[Calling]" line in the transcript was a different call.',
      '<call_script>',
      call.script.slice(0, SCRIPT_MAX_CHARS),
      '</call_script>',
    ];
    return [meetingGoals.trim(), lines.join('\n')].filter(Boolean).join('\n\n');
  }
}

/** The script as a pinned context doc, for the suggestions' context block. */
export function callScriptDoc(call: CallOnLine, sessionDir: string): ContextDoc {
  const content = `# Now calling: ${call.companyName}\n\n${call.script.slice(0, SCRIPT_MAX_CHARS)}`;
  return {
    name: `Now calling: ${call.companyName}`,
    relativePath: CALL_SCRIPT_DOC_PATH,
    dirPath: sessionDir,
    content,
    firstLine: `Now calling: ${call.companyName}`,
    sizeChars: content.length,
    pinned: true,
  };
}

/** The docs with this call's script in place of the last call's. */
export function swapCallScriptDoc(docs: ContextDoc[], doc: ContextDoc): ContextDoc[] {
  return [doc, ...docs.filter((d) => d.relativePath !== CALL_SCRIPT_DOC_PATH)];
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export function parseDialBody(body: unknown): DialInput | string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const companyId = text(b.companyId, 64);
  const companyName = text(b.companyName, 200);
  const phone = text(b.phone, 40);
  if (!companyId || !companyName) return 'companyId and companyName are required';
  return {
    companyId,
    companyName,
    phone,
    pitch: text(b.pitch, 40) || 'consulting',
    script: text(b.scriptMarkdown, SCRIPT_MAX_CHARS),
  };
}

export function parseDraftBody(body: unknown): { companyId: string; outcomes: DraftOutcome[] } | string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const companyId = text(b.companyId, 64);
  if (!companyId) return 'companyId is required';
  const outcomes = (Array.isArray(b.outcomes) ? b.outcomes : [])
    .map((o) => (o && typeof o === 'object' ? (o as Record<string, unknown>) : {}))
    .map((o) => ({ id: text(o.id, 40), label: text(o.label, 80) }))
    .filter((o) => /^[a-z_]+$/.test(o.id) && o.label)
    .slice(0, 20);
  if (outcomes.length === 0) return 'outcomes are required';
  return { companyId, outcomes };
}

export const DRAFT_SYSTEM = [
  'You fill in a cold-call log from the transcript of ONE short phone call.',
  '"You" lines are the caller. Every other line is the other end: the person who answered, an answering machine, or hold audio.',
  '',
  'Return JSON only: {"outcome": <one id from the list, or null>, "said": <string>, "notes": <string>}',
  '- outcome: the id that best describes how the call ended. null if the transcript cannot tell you.',
  '  A recorded greeting with the caller then leaving a message is a voicemail. Ringing or a greeting with no message left is no answer.',
  '  Pick a yes (a booked meeting, a yes to the plan) ONLY if the other end clearly agreed. Pick "take me off your list" only if they asked for it.',
  '- said: the other end\'s own words, quoted from the transcript, the one or two lines that matter most. Empty if they said nothing useful. Never paraphrase into a quote.',
  '- notes: short facts for the follow-up: who answered and their role, a name, email or number they gave, a time to call back, the objection they raised. Empty if none. Never invent anything not in the transcript.',
].join('\n');

export const DRAFT_SCHEMA: LiveJsonSchema = {
  name: 'call_log_draft',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['outcome', 'said', 'notes'],
    properties: {
      outcome: { type: ['string', 'null'] },
      said: { type: 'string' },
      notes: { type: 'string' },
    },
  },
};

/** The transcript rows of this call: everything after its `[Calling]` row, markers excluded. */
export function rowsSinceDial(rows: TranscriptRecord[], call: CallOnLine): TranscriptRecord[] {
  return rows.filter((r) => r.timestamp >= call.startedAt && r.source !== 'system');
}

export function buildDraftPrompt(call: CallOnLine, rows: TranscriptRecord[], outcomes: DraftOutcome[]): string {
  let transcript = rows.map((r) => `${r.label} ${r.text}`).join('\n');
  if (transcript.length > DRAFT_TRANSCRIPT_MAX_CHARS) transcript = transcript.slice(-DRAFT_TRANSCRIPT_MAX_CHARS);
  return [
    `Business called: ${call.companyName}`,
    'Outcomes to choose from (id: meaning):',
    ...outcomes.map((o) => `- ${o.id}: ${o.label}`),
    '',
    '<transcript>',
    transcript,
    '</transcript>',
  ].join('\n');
}

/** The model's draft, with an outcome it was not offered dropped rather than trusted. */
export function parseDraftReply(textIn: string, allowed: readonly string[]): Omit<CallDraft, 'words'> | null {
  const o = parseFirstJsonObject<Record<string, unknown>>(textIn, (v) => 'said' in v || 'outcome' in v);
  if (!o) return null;
  const outcome = typeof o.outcome === 'string' && allowed.includes(o.outcome) ? o.outcome : null;
  return { outcome, said: text(o.said, 1000), notes: text(o.notes, 4000) };
}

export async function draftWithModel(prompt: string, signal?: AbortSignal): Promise<string> {
  const result = await runLiveJson({
    prompt,
    systemPrompt: DRAFT_SYSTEM,
    schema: DRAFT_SCHEMA,
    openAiModel: MODEL_CONFIG.compression,
    label: 'call-draft',
    signal,
    providerTimeoutMs: 20_000,
    totalTimeoutMs: 75_000,
    maxOutputTokens: 500,
  });
  return result.text;
}

interface BridgeStore {
  readonly id: string;
  readonly directory: string;
  addMarker(id: string, label: string, text: string, timestamp: number): void;
  getTranscript(): TranscriptRecord[];
}

export interface CallRouterDeps {
  bridge: CallBridge;
  session: () => { store: BridgeStore | null; active: boolean };
  getDocs: () => ContextDoc[];
  setDocs: (docs: ContextDoc[]) => void;
  /** Sends `call.dialing` to every socket (the dashboard draws the marker). */
  broadcast: (event: { type: 'call.dialing'; sessionId: string; companyName: string; marker: { id: string; label: string; text: string; timestamp: number } }) => void;
  draft?: (prompt: string, signal?: AbortSignal) => Promise<string>;
  now?: () => number;
  log?: (message: string) => void;
}

/** Same-machine tools send no Origin and are let through, like every other route here. */
function originGuard(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  if (origin) {
    if (!CALL_BRIDGE_ORIGINS.includes(origin)) {
      res.status(403).json({ ok: false, error: 'origin not allowed' });
      return;
    }
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      // Chrome's private/local network access preflight from a public page.
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });
  }
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

function prettyPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : phone;
}

export function createCallRouter(deps: CallRouterDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  const draft = deps.draft ?? draftWithModel;
  const log = deps.log ?? (() => {});

  router.use('/call', originGuard);

  router.get('/call/status', (_req, res) => {
    const { store, active } = deps.session();
    const call = deps.bridge.calling;
    res.json({
      session: Boolean(active && store),
      calling: call ? { companyId: call.companyId, companyName: call.companyName, startedAt: call.startedAt } : null,
    });
  });

  router.post('/call/dial', (req, res) => {
    const { store, active } = deps.session();
    if (!active || !store) {
      res.status(409).json({ ok: false, error: 'No copilot session is running.' });
      return;
    }
    const input = parseDialBody(req.body);
    if (typeof input === 'string') {
      res.status(400).json({ ok: false, error: input });
      return;
    }
    const at = now();
    const call = deps.bridge.dial(input, at);
    const marker = {
      id: randomUUID(),
      label: CALL_MARKER_LABEL,
      text: [call.companyName, call.phone && prettyPhone(call.phone)].filter(Boolean).join(' · '),
      timestamp: at,
    };
    store.addMarker(marker.id, marker.label, marker.text, marker.timestamp);
    if (call.script) deps.setDocs(swapCallScriptDoc(deps.getDocs(), callScriptDoc(call, store.directory)));
    else deps.setDocs(deps.getDocs().filter((d) => d.relativePath !== CALL_SCRIPT_DOC_PATH));
    deps.broadcast({ type: 'call.dialing', sessionId: store.id, companyName: call.companyName, marker });
    log(`dial: script ${call.script.length} chars`);
    res.json({ ok: true, startedAt: at });
  });

  router.post('/call/draft', async (req, res) => {
    const { store } = deps.session();
    const parsed = parseDraftBody(req.body);
    if (typeof parsed === 'string') {
      res.status(400).json({ ok: false, error: parsed });
      return;
    }
    const call = deps.bridge.calling;
    if (!store || !call || call.companyId !== parsed.companyId) {
      res.status(409).json({ ok: false, error: "The copilot didn't hear a dial for this business. Fill it in by hand." });
      return;
    }
    const rows = rowsSinceDial(store.getTranscript(), call);
    const words = rows.reduce((sum, r) => sum + (r.wordCount || 0), 0);
    if (words === 0) {
      res.json({ ok: true, outcome: null, said: '', notes: '', words: 0 } satisfies CallDraft & { ok: true });
      return;
    }
    try {
      const reply = await draft(buildDraftPrompt(call, rows, parsed.outcomes));
      const d = parseDraftReply(reply, parsed.outcomes.map((o) => o.id));
      if (!d) {
        res.status(502).json({ ok: false, error: "The copilot's draft didn't come back usable. Fill it in by hand." });
        return;
      }
      log(`draft: ${rows.length} rows, outcome ${d.outcome ?? 'none'}`);
      res.json({ ok: true, ...d, words });
    } catch (err) {
      log(`draft failed: ${(err as Error).message}`);
      res.status(502).json({ ok: false, error: "The copilot couldn't draft this call. Fill it in by hand." });
    }
  });

  return router;
}
