import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { callTool, NO_MEETING, type Endpoint } from '../mcp.js';

/**
 * The MCP against a REAL second copilot server (this checkout's src/index.ts)
 * in a throwaway HOME, set up like the e2e ship gate (e2e/harness.ts): no API
 * keys, no `claude` on PATH, the scripted chat answerer, the pulse off. It
 * proves the server side of requestId: acks reach the asker only, and an
 * answer is matched to its own question while another client asks too.
 * Never touches the live app: its socket is under the throwaway HOME.
 */

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TITLE = 'MCP live check';

let home = '';
let server: ChildProcess | null = null;
let endpoint: Endpoint;
let app: WebSocket | null = null;
let exited: string | null = null;

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const a = probe.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      probe.close(() => done(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function health(port: number): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    return r.ok ? (await r.json()) as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

beforeAll(async () => {
  home = realpathSync(mkdtempSync('/tmp/mcmcp-'));
  if (home === realpathSync(userInfo().homedir)) throw new Error('Refusing to run against the real HOME');
  const copilotDir = join(home, '.meeting-copilot');
  mkdirSync(join(copilotDir, 'sessions'), { recursive: true });
  mkdirSync(join(home, 'tmp'));
  writeFileSync(join(copilotDir, 'settings.json'), JSON.stringify({
    version: 1,
    monitorDefaults: { coach: false, factcheck: false },
    summaryAutoWrite: false,
    matchVaultAppearance: false,
  }));
  const port = await freePort();
  const out = openSync(join(home, 'server.out'), 'a');
  server = spawn(process.execPath, ['--import', pathToFileURL(join(SERVER_DIR, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, join(SERVER_DIR, 'src', 'index.ts')], {
    cwd: home,
    env: {
      HOME: home,
      USER: process.env.USER,
      LANG: 'en_US.UTF-8',
      TMPDIR: join(home, 'tmp'),
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      COPILOT_PORT: String(port),
      COPILOT_DISABLE_PAID_API: '1',
      COPILOT_PULSE: '0',
      COPILOT_OPEN_EVIDENCE: '0',
      COPILOT_RESEARCH_DEEP_FOLLOWUP: '0',
      COPILOT_CLOUD_TRANSCRIPTION: 'off',
      COPILOT_E2E_FAKE_CHAT: '1',
      SHARE_TRANSCRIPT: 'false',
      TRANSCRIPTION_PROVIDER: 'parakeet',
      PARAKEET_URL: 'http://127.0.0.1:9',
      ONYX_URL: 'http://127.0.0.1:9',
    },
    stdio: ['ignore', out, out],
  });
  closeSync(out);
  server.once('exit', (code, signal) => { exited = `exit ${code ?? signal}`; });
  let h: Record<string, unknown> | null = null;
  for (let i = 0; i < 200 && !exited && !h; i++) {
    h = await health(port);
    if (!h) await sleep(100);
  }
  if (!h || h.fakeChat !== true) {
    throw new Error(`Test server did not start in e2e mode (${exited ?? JSON.stringify(h)}):\n${readFileSync(join(home, 'server.out'), 'utf8').slice(-3000)}`);
  }
  endpoint = { socketPath: join(copilotDir, 'copilot.sock'), port };
}, 30_000);

afterAll(async () => {
  try { app?.send(JSON.stringify({ type: 'session.stop' })); } catch { /* gone */ }
  app?.close();
  if (server && !exited) {
    server.kill('SIGTERM');
    for (let i = 0; i < 30 && !exited; i++) await sleep(100);
    if (!exited) server.kill('SIGKILL');
  }
  if (home) rmSync(home, { recursive: true, force: true });
});

async function openApp(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${endpoint.port}`);
  await new Promise<void>((done, fail) => { ws.once('open', () => done()); ws.once('error', fail); });
  return ws;
}

describe('MCP against a real copilot server', () => {
  it('before a meeting: status is idle and the actions say no meeting is live', async () => {
    const s = await callTool('status', {}, { endpoint });
    expect(s.structuredContent).toMatchObject({ live: false, connectedVia: 'socket' });
    const a = await callTool('ask', { question: 'anything?' }, { endpoint });
    expect(a.isError).toBe(true);
    expect(a.content[0].text).toBe(NO_MEETING);
  });

  it('a live meeting: status, ask (correlated by requestId while another client asks), pulse refused, research fails cleanly', async () => {
    app = await openApp();
    app.send(JSON.stringify({ type: 'session.start', title: TITLE, agenda: 'Pricing', attendees: 'Dana' }));
    for (let i = 0; i < 50; i++) {
      if ((await health(endpoint.port))?.session) break;
      await sleep(100);
    }

    const s = await callTool('status', {}, { endpoint });
    expect(s.structuredContent).toMatchObject({ live: true, title: TITLE, state: 'live', elapsedMinutes: 0 });

    const t = await callTool('transcript', {}, { endpoint });
    expect(t.isError).toBeFalsy();
    expect(t.structuredContent).toMatchObject({ count: 0 });

    // Another client (the app's menu bar) asks the SAME question at the same moment.
    const heard: Array<Record<string, any>> = [];
    app.on('message', (raw) => { try { heard.push(JSON.parse(raw.toString())); } catch { /* binary */ } });
    app.send(JSON.stringify({ type: 'chat.send', text: 'What is on the agenda?', origin: 'menubar' }));
    const [mine, again] = await Promise.all([
      callTool('ask', { question: 'What is on the agenda?' }, { endpoint }),
      callTool('ask', { question: 'Who is here?' }, { endpoint }),
    ]);
    expect(mine.isError).toBeFalsy();
    expect(mine.content[0].text).toContain(`Fake answer about "${TITLE}"`);
    expect(mine.structuredContent).toMatchObject({ state: 'done', via: 'e2e-fake', correlated: 'requestId' });
    expect(again.structuredContent).toMatchObject({ state: 'done', correlated: 'requestId' });
    // Three questions, three distinct answers: each MCP call followed its own.
    const ids = new Set([mine.structuredContent!.messageId, again.structuredContent!.messageId]);
    expect(ids.size).toBe(2);
    // The app's own question gets its own answer too (turns run in order, so it may land last).
    const doneAnswers = () => heard.filter((m) => m.type === 'chat.message' && m.message?.role === 'assistant' && m.message?.state === 'done');
    for (let i = 0; i < 50 && doneAnswers().length < 3; i++) await sleep(100);
    expect(new Set(doneAnswers().map((m) => m.message.id)).size).toBe(3);
    // The asker-only replies never reach the other client.
    expect(heard.some((m) => m.type === 'request.ack' || m.type === 'request.result')).toBe(false);

    const p = await callTool('pulse', { kind: 'checkin' }, { endpoint });
    expect(p.isError).toBe(true);
    expect(p.content[0].text).toContain('pulse is off');

    // No model is reachable here (no keys, no claude on PATH), so the card
    // fails; what matters is that the MCP followed ITS card to the end.
    const r = await callTool('research', { prompt: 'Acme funding', fast: true }, { endpoint, timeouts: { research: 20_000 } });
    expect(r.structuredContent).toMatchObject({ actionType: 'fast-research', correlated: 'requestId' });
    expect(typeof r.structuredContent!.actionId).toBe('string');
    expect(r.structuredContent!.timedOut).toBeUndefined();

    // Suggest has no model here either: it must come back (answer or failure)
    // through request.result, not sit until the deadline.
    const g = await callTool('suggest', { focus: 'pricing' }, { endpoint, timeouts: { suggest: 20_000 } });
    expect(g.structuredContent!.timedOut).toBeUndefined();
    expect(g.structuredContent).toMatchObject({ correlated: 'requestId' });
  }, 40_000);
});
