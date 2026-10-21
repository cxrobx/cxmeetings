import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ContextDoc } from '../context/index.js';
import type { TranscriptRecord } from '../session/store.js';
import {
  CALL_MARKER_LABEL,
  CALL_SCRIPT_DOC_PATH,
  CallBridge,
  createCallRouter,
  parseDraftReply,
} from '../call/bridge.js';

const OUTCOMES = [
  { id: 'no_answer', label: 'No answer' },
  { id: 'voicemail', label: 'Left voicemail' },
  { id: 'plan_yes', label: 'Said yes to the website plan' },
];

function row(over: Partial<TranscriptRecord>): TranscriptRecord {
  return { id: Math.random().toString(36), sessionId: 's1', text: '', source: 'meeting', label: 'Them:', timestamp: 0, duration: 0, wordCount: 0, redacted: 0, ...over } as TranscriptRecord;
}

describe('call bridge over HTTP', () => {
  let server: Server;
  let base: string;
  let t = 1_000_000;
  let active = true;
  let rows: TranscriptRecord[] = [];
  let docs: ContextDoc[] = [];
  let broadcasts: unknown[] = [];
  let prompts: string[] = [];
  let reply = '';
  const bridge = new CallBridge();
  const store = {
    id: 's1',
    directory: '/tmp/s1',
    addMarker(id: string, label: string, text: string, timestamp: number) {
      rows.push(row({ id, label, text, timestamp, source: 'system' }));
    },
    getTranscript: () => rows,
  };

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(createCallRouter({
      bridge,
      session: () => ({ store: active ? store : null, active }),
      getDocs: () => docs,
      setDocs: (d) => { docs = d; },
      broadcast: (e) => { broadcasts.push(e); },
      draft: async (prompt) => { prompts.push(prompt); return reply; },
      now: () => t,
    }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    bridge.reset();
    active = true;
    rows = [];
    docs = [{ name: 'notes.md', relativePath: 'notes.md', dirPath: '/x', content: 'n', firstLine: 'n', sizeChars: 1 }];
    broadcasts = [];
    prompts = [];
  });

  const post = (path: string, body: unknown, origin = 'https://cxventures.io') =>
    fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  const dial = (companyId = 'c1', companyName = 'Smith Plumbing') =>
    post('/call/dial', { companyId, companyName, phone: '7065550142', pitch: 'website_plan', scriptMarkdown: '## Open\nHi, is this the owner?' });

  it('refuses any other site before touching the session', async () => {
    const res = await post('/call/dial', { companyId: 'c1', companyName: 'X' }, 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(bridge.calling).toBeNull();
    expect(rows).toHaveLength(0);
    const status = await fetch(`${base}/call/status`, { headers: { Origin: 'https://evil.example' } });
    expect(status.status).toBe(403);
  });

  it('answers the preflight from cxventures.io, local network access included', async () => {
    const res = await fetch(`${base}/call/dial`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://cxventures.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://cxventures.io');
    expect(res.headers.get('access-control-allow-headers')).toMatch(/content-type/i);
    expect(res.headers.get('access-control-allow-private-network')).toBe('true');
  });

  it('a dial with no session running is refused, not remembered', async () => {
    active = false;
    expect((await dial()).status).toBe(409);
    expect(bridge.calling).toBeNull();
    const s = await (await fetch(`${base}/call/status`)).json();
    expect(s).toEqual({ session: false, calling: null });
  });

  it('a dial leaves the divider, pins the script, and replaces the last call\'s script', async () => {
    expect((await dial()).status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: CALL_MARKER_LABEL, source: 'system', text: 'Smith Plumbing · (706) 555-0142' });
    expect(broadcasts[0]).toMatchObject({ type: 'call.dialing', sessionId: 's1', companyName: 'Smith Plumbing' });
    expect(docs[0]).toMatchObject({ relativePath: CALL_SCRIPT_DOC_PATH, pinned: true });
    expect(docs[0]!.content).toContain('Hi, is this the owner?');

    t += 120_000;
    await dial('c2', 'Jones Auto');
    const scripts = docs.filter((d) => d.relativePath === CALL_SCRIPT_DOC_PATH);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.name).toBe('Now calling: Jones Auto');
    expect(docs.some((d) => d.relativePath === 'notes.md')).toBe(true);
    const s = (await (await fetch(`${base}/call/status`, { headers: { Origin: "https://cxventures.io" } })).json()) as { calling: unknown };
    expect(s.calling).toMatchObject({ companyId: 'c2', companyName: 'Jones Auto' });
  });

  it('the coach and chat see the call through the goals; with no call they see only the user\'s', async () => {
    expect(bridge.goalsWith('Book two meetings')).toBe('Book two meetings');
    await dial();
    const g = bridge.goalsWith('Book two meetings', t + 3 * 60_000);
    expect(g.startsWith('Book two meetings\n\nON THE PHONE NOW: Smith Plumbing (website plan pitch), dialed 3 min ago.')).toBe(true);
    expect(g).toContain('<call_script>\n## Open\nHi, is this the owner?\n</call_script>');
    bridge.reset();
    expect(bridge.goalsWith('')).toBe('');
  });

  it('drafts only from what was said after this dial, and drops an outcome the page did not offer', async () => {
    rows.push(row({ text: 'an earlier call, not this one', timestamp: t - 5_000, wordCount: 6 }));
    await dial();
    rows.push(row({ label: 'You:', source: 'mic', text: 'Hi, is this the owner?', timestamp: t + 1_000, wordCount: 5 }));
    rows.push(row({ text: 'Yes, sign me up, my email is bo@smith.co', timestamp: t + 4_000, wordCount: 8 }));
    reply = '{"outcome":"door_booked","said":"Yes, sign me up","notes":"email bo@smith.co"}';
    const res = await post('/call/draft', { companyId: 'c1', outcomes: OUTCOMES });
    const d = await res.json();
    expect(d).toEqual({ ok: true, outcome: null, said: 'Yes, sign me up', notes: 'email bo@smith.co', words: 13 });
    expect(prompts[0]).toContain('- plan_yes: Said yes to the website plan');
    expect(prompts[0]).toContain('Yes, sign me up');
    expect(prompts[0]).not.toContain('an earlier call');
    expect(prompts[0]).not.toContain(CALL_MARKER_LABEL);
  });

  it('heard nothing: no model call, and the page is told so', async () => {
    await dial();
    const d = await (await post('/call/draft', { companyId: 'c1', outcomes: OUTCOMES })).json();
    expect(d).toEqual({ ok: true, outcome: null, said: '', notes: '', words: 0 });
    expect(prompts).toHaveLength(0);
  });

  it('a draft for a business that was not dialed is refused', async () => {
    await dial('c1');
    expect((await post('/call/draft', { companyId: 'c9', outcomes: OUTCOMES })).status).toBe(409);
    expect((await post('/call/draft', { companyId: 'c1', outcomes: [] })).status).toBe(400);
  });
});

describe('parseDraftReply', () => {
  it('reads the first object and survives a trailing tail (gotcha #21)', () => {
    expect(parseDraftReply('{"outcome":"voicemail","said":"","notes":"left msg"} and more text', ['voicemail'])).toEqual({
      outcome: 'voicemail',
      said: '',
      notes: 'left msg',
    });
    expect(parseDraftReply('no json here', ['voicemail'])).toBeNull();
  });
});
