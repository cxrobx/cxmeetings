import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { callTool, handleRpc, NO_MEETING, type Endpoint, type ToolOptions } from '../mcp.js';

/**
 * The MCP against a fake copilot server: HTTP /health + /transcript and a
 * WebSocket that sends the real server's broadcast shapes (index.ts). Each
 * test scripts how the fake answers each request type.
 */

type Msg = Record<string, any>;
type Handler = (msg: Msg, ctx: { reply: (m: Msg) => void; broadcast: (m: Msg) => void }) => void;

interface Fake {
  endpoint: Endpoint;
  live: boolean;
  /** No requestId support: no request.ack / request.result (a server built before it). */
  legacy: boolean;
  segments: Msg[];
  handlers: Record<string, Handler>;
  received: Msg[];
  close: () => Promise<void>;
}

const SESSION = 'sess-1';
const STARTED = Date.now() - 23 * 60_000;

async function startFake(opts: { socket?: boolean; tcp?: boolean } = { socket: true, tcp: true }): Promise<Fake> {
  const dir = mkdtempSync(join(tmpdir(), 'mcmcp-'));
  const socketPath = join(dir, 's.sock');
  const fake: Fake = {
    endpoint: { socketPath: opts.socket ? socketPath : null, port: 9 },
    live: true,
    legacy: false,
    segments: [],
    handlers: {},
    received: [],
    close: async () => {},
  };
  const servers: Server[] = [];
  const sockets = new Set<WebSocket>();
  const broadcast = (m: Msg) => {
    for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  const make = () => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', session: fake.live ? SESSION : null }));
      if (req.url === '/transcript') {
        return res.end(JSON.stringify(fake.live ? { segments: fake.segments, active: true, sessionId: SESSION } : { segments: [], active: false }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => {
      sockets.add(ws);
      ws.send(JSON.stringify({ type: 'session.state', state: fake.live ? 'live' : 'idle', sessionId: SESSION, startedAt: fake.live ? STARTED : undefined, title: fake.live ? 'Pricing with Dana' : undefined }));
      // Noise every client gets on connect, as the real server replays history.
      ws.send(JSON.stringify({ type: 'feature.state', features: { factcheck: false, coach: true } }));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as Msg;
        fake.received.push(msg);
        const reply = (m: Msg) => {
          if (fake.legacy && (m.type === 'request.ack' || m.type === 'request.result')) return;
          ws.send(JSON.stringify(m));
        };
        fake.handlers[msg.type]?.(msg, { reply, broadcast });
      });
      ws.on('close', () => sockets.delete(ws));
    });
    servers.push(server);
    return server;
  };
  if (opts.socket) await new Promise<void>((r) => make().listen(socketPath, r));
  if (opts.tcp) {
    const s = make();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    fake.endpoint.port = (s.address() as AddressInfo).port;
  }
  fake.close = async () => {
    for (const ws of sockets) ws.terminate();
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    rmSync(dir, { recursive: true, force: true });
  };
  return fake;
}

const after = (ms: number, fn: () => void) => setTimeout(fn, ms);

/** The real server's chat turn: user + placeholder, deltas, then the finished answer. */
function chatTurn(broadcast: (m: Msg) => void, text: string, answer: string, ids: { user: string; asst: string }, delayMs = 20) {
  const now = Date.now();
  broadcast({ type: 'chat.message', sessionId: SESSION, message: { id: ids.user, role: 'user', content: text, origin: 'menubar', state: 'done', createdAt: now } });
  broadcast({ type: 'chat.message', sessionId: SESSION, message: { id: ids.asst, role: 'assistant', content: '', origin: 'menubar', state: 'streaming', via: '', createdAt: now } });
  const words = answer.match(/\S+\s*/g) ?? [];
  words.forEach((w, i) => after(delayMs * (i + 1), () => broadcast({ type: 'chat.delta', sessionId: SESSION, id: ids.asst, seq: i + 1, text: w })));
  after(delayMs * (words.length + 2), () => broadcast({ type: 'chat.message', sessionId: SESSION, message: { id: ids.asst, role: 'assistant', content: answer, origin: 'menubar', state: 'done', via: 'gpt-6-luna', createdAt: now } }));
}

let fake: Fake;
let opts: ToolOptions;

beforeEach(async () => {
  fake = await startFake();
  opts = { endpoint: fake.endpoint, timeouts: { ackGrace: 150, connect: 1_000 } };
});
afterEach(async () => {
  await fake.close();
});

describe('status', () => {
  it('reports the live meeting over the Unix socket', async () => {
    const r = await callTool('status', {}, opts);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ live: true, sessionId: SESSION, title: 'Pricing with Dana', state: 'live', elapsedMinutes: 23, connectedVia: 'socket' });
    expect(r.content[0].text).toContain('Pricing with Dana');
  });

  it('falls back to TCP when there is no socket', async () => {
    const r = await callTool('status', {}, { ...opts, endpoint: { socketPath: '/nonexistent/x.sock', port: fake.endpoint.port } });
    expect(r.structuredContent).toMatchObject({ live: true, connectedVia: 'tcp' });
  });

  it('says plainly when no meeting is live (not an error: status is the question)', async () => {
    fake.live = false;
    const r = await callTool('status', {}, opts);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ live: false, sessionId: null, state: 'idle' });
    expect(r.content[0].text).toContain(NO_MEETING);
  });
});

describe('transcript', () => {
  it('returns recent segments as "speaker: text", honoring minutes and limit', async () => {
    const now = Date.now();
    fake.segments = [
      { id: 'a', text: 'Old news.', source: 'meeting', label: 'Them', timestamp: now - 30 * 60_000 },
      { id: 'b', text: 'What is the price?', source: 'meeting', label: 'Them', timestamp: now - 4 * 60_000 },
      { id: 'c', text: ' Forty a seat. ', source: 'mic', label: 'You', timestamp: now - 3 * 60_000 },
      { id: 'd', text: 'Deal.', source: 'meeting', label: 'Them', timestamp: now - 60_000 },
    ];
    const r = await callTool('transcript', {}, opts);
    expect(r.content[0].text).toBe('Them: What is the price?\nYou: Forty a seat.\nThem: Deal.');
    expect(r.structuredContent).toMatchObject({ minutes: 10, count: 3, totalSegments: 4 });
    const limited = await callTool('transcript', { minutes: 60, limit: 2 }, opts);
    expect(limited.content[0].text).toBe('You: Forty a seat.\nThem: Deal.');
  });
});

describe('ask', () => {
  it('sends chat.send with a requestId and returns the finished answer', async () => {
    fake.handlers['chat.send'] = (m, { reply, broadcast }) => {
      chatTurn(broadcast, m.text, 'Forty dollars a seat, per the deck.', { user: 'u1', asst: 'a1' });
      reply({ type: 'request.ack', requestId: m.requestId, ok: true, sessionId: SESSION, userMessageId: 'u1', assistantMessageId: 'a1' });
    };
    const r = await callTool('ask', { question: 'What price did we quote?' }, opts);
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toBe('Forty dollars a seat, per the deck.');
    expect(r.structuredContent).toMatchObject({ messageId: 'a1', state: 'done', via: 'gpt-6-luna', correlated: 'requestId' });
    expect(fake.received[0]).toMatchObject({ type: 'chat.send', text: 'What price did we quote?', origin: 'menubar' });
    expect(typeof fake.received[0].requestId).toBe('string');
  });

  it('ignores another client\'s question and answer asked at the same moment', async () => {
    fake.handlers['chat.send'] = (m, { reply, broadcast }) => {
      // Another client's turn — same question text, even — lands first and finishes first.
      chatTurn(broadcast, m.text, 'The OTHER client\'s answer.', { user: 'u0', asst: 'a0' }, 5);
      chatTurn(broadcast, m.text, 'Our answer.', { user: 'u1', asst: 'a1' }, 30);
      reply({ type: 'request.ack', requestId: 'someone-else', ok: true, assistantMessageId: 'a0' });
      reply({ type: 'request.ack', requestId: m.requestId, ok: true, sessionId: SESSION, userMessageId: 'u1', assistantMessageId: 'a1' });
    };
    const r = await callTool('ask', { question: 'Same question' }, opts);
    expect(r.content[0].text).toBe('Our answer.');
    expect(r.structuredContent).toMatchObject({ messageId: 'a1', correlated: 'requestId' });
  });

  it('matches by the question text against a server that predates requestId', async () => {
    fake.legacy = true;
    fake.handlers['chat.send'] = (m, { broadcast }) => {
      chatTurn(broadcast, 'Someone else asked this', 'Not ours.', { user: 'u0', asst: 'a0' }, 5);
      chatTurn(broadcast, m.text, 'Ours, matched by text.', { user: 'u1', asst: 'a1' }, 10);
    };
    const r = await callTool('ask', { question: 'Our question' }, opts);
    expect(r.content[0].text).toBe('Ours, matched by text.');
    expect(r.structuredContent).toMatchObject({ messageId: 'a1', correlated: 'heuristic' });
  });

  it('times out with what streamed so far and never hangs past the deadline', async () => {
    fake.handlers['chat.send'] = (m, { reply, broadcast }) => {
      broadcast({ type: 'chat.message', sessionId: SESSION, message: { id: 'a1', role: 'assistant', content: '', state: 'streaming', origin: 'menubar' } });
      broadcast({ type: 'chat.delta', sessionId: SESSION, id: 'a1', seq: 1, text: 'Half an ' });
      reply({ type: 'request.ack', requestId: m.requestId, ok: true, assistantMessageId: 'a1' });
    };
    const t0 = Date.now();
    const r = await callTool('ask', { question: 'Slow one' }, { ...opts, timeouts: { ...opts.timeouts, ask: 600 } });
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Half an');
    expect(r.structuredContent).toMatchObject({ timedOut: true, state: 'streaming' });
  });

  it('reports an answer that failed', async () => {
    fake.handlers['chat.send'] = (m, { reply, broadcast }) => {
      reply({ type: 'request.ack', requestId: m.requestId, ok: true, assistantMessageId: 'a1' });
      after(10, () => broadcast({ type: 'chat.message', sessionId: SESSION, message: { id: 'a1', role: 'assistant', content: '', state: 'error', error: 'rate limited' } }));
    };
    const r = await callTool('ask', { question: 'x' }, opts);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('rate limited');
  });
});

describe('pulse', () => {
  const pulse = { id: 'p1', mode: 'pulse', trigger: 'check-in', status: 'on-track', read: 'Pricing settled; next steps open.', escalations: [], closeOut: [{ text: 'Confirm the start date' }], missed: [], minutesIn: 23, minutesLeft: 7, createdAt: Date.now(), latencyMs: 28_000 };

  it('checkin waits for its request.result and formats the read', async () => {
    fake.handlers['pulse.request'] = (m, { reply, broadcast }) => {
      broadcast({ type: 'ask.state', kind: 'checkin', phase: 'started', title: 'How am I doing?' });
      reply({ type: 'request.ack', requestId: m.requestId, ok: true, kind: 'checkin' });
      after(50, () => {
        broadcast({ type: 'pulse.update', pulse });
        broadcast({ type: 'ask.state', kind: 'checkin', phase: 'done', title: 'How am I doing? · on track', body: pulse.read });
        reply({ type: 'request.result', requestId: m.requestId, kind: 'checkin', ok: true, pulse, title: 'How am I doing? · on track', body: pulse.read });
      });
    };
    const r = await callTool('pulse', { kind: 'checkin' }, opts);
    expect(r.isError).toBeFalsy();
    expect(fake.received[0]).toMatchObject({ type: 'pulse.request', kind: 'checkin' });
    expect(r.content[0].text).toContain('How am I doing? · on track');
    expect(r.content[0].text).toContain('- Confirm the start date');
    expect(r.structuredContent).toMatchObject({ kind: 'checkin', correlated: 'requestId', pulse: { id: 'p1' } });
  });

  it('wrapup is sent as the close-out kind', async () => {
    fake.handlers['pulse.request'] = (m, { reply }) => {
      reply({ type: 'request.ack', requestId: m.requestId, ok: true });
      reply({ type: 'request.result', requestId: m.requestId, kind: 'wrapup', ok: true, pulse: { ...pulse, trigger: 'manual' }, title: 'Before this call ends', body: 'Confirm the start date' });
    };
    const r = await callTool('pulse', { kind: 'wrapup' }, opts);
    expect(fake.received[0]).toMatchObject({ type: 'pulse.request', kind: 'closeout' });
    expect(r.content[0].text).toContain('Before this call ends');
  });

  it('is an error when the server refuses it', async () => {
    fake.handlers['pulse.request'] = (m, { reply }) => reply({ type: 'request.ack', requestId: m.requestId, ok: false, error: 'The meeting pulse is off (COPILOT_PULSE=0)' });
    const r = await callTool('pulse', { kind: 'missed' }, opts);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('pulse is off');
  });

  it('times out at its deadline', async () => {
    fake.handlers['pulse.request'] = (m, { reply }) => reply({ type: 'request.ack', requestId: m.requestId, ok: true });
    const t0 = Date.now();
    const r = await callTool('pulse', { kind: 'checkin' }, { ...opts, timeouts: { ...opts.timeouts, pulse: 400 } });
    expect(Date.now() - t0).toBeLessThan(1_200);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ timedOut: true });
  });

  it('ignores another client\'s read finishing first (requestId wins over look-alike broadcasts)', async () => {
    fake.handlers['pulse.request'] = (m, { reply, broadcast }) => {
      reply({ type: 'request.ack', requestId: m.requestId, ok: true });
      // A different kind's done arrives first; then ours.
      broadcast({ type: 'ask.state', kind: 'missed', phase: 'done', title: 'You may have missed', body: 'not ours' });
      broadcast({ type: 'ask.state', kind: 'checkin', phase: 'done', title: 'stale broadcast', body: 'not ours either' });
      after(300, () => reply({ type: 'request.result', requestId: m.requestId, kind: 'checkin', ok: true, pulse, title: 'Ours', body: pulse.read }));
    };
    const r = await callTool('pulse', { kind: 'checkin' }, opts);
    expect(r.content[0].text).toContain('Ours');
    expect(r.structuredContent).toMatchObject({ correlated: 'requestId' });
  });
});

describe('suggest', () => {
  const card = { id: 'c1', asked: true, kind: 'ask', headline: 'Anchor on value', phrasing: 'Before price, can we agree on the outcome?', why: 'They pushed on cost twice.', priority: 1, confidence: 0.8 };

  it('sends coach.ask with the focus and returns the card', async () => {
    fake.handlers['coach.ask'] = (m, { reply, broadcast }) => {
      reply({ type: 'request.ack', requestId: m.requestId, ok: true, kind: 'suggest' });
      after(30, () => {
        broadcast({ type: 'coach.suggestion', suggestion: card });
        reply({ type: 'request.result', requestId: m.requestId, kind: 'suggest', ok: true, suggestion: card, title: card.headline, body: card.phrasing });
      });
    };
    const r = await callTool('suggest', { focus: 'pricing' }, opts);
    expect(fake.received[0]).toMatchObject({ type: 'coach.ask', focus: 'pricing' });
    expect(r.content[0].text).toBe('Anchor on value\n\nSay: Before price, can we agree on the outcome?\n\nWhy: They pushed on cost twice.');
    expect(r.structuredContent).toMatchObject({ suggestion: { id: 'c1' }, correlated: 'requestId' });
  });

  it('says when there is nothing worth saying', async () => {
    fake.handlers['coach.ask'] = (m, { reply }) => {
      reply({ type: 'request.ack', requestId: m.requestId, ok: true });
      reply({ type: 'request.result', requestId: m.requestId, kind: 'suggest', ok: true, suggestion: null, empty: true });
    };
    const r = await callTool('suggest', {}, opts);
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toBe('Nothing worth saying right now.');
  });

  it('falls back to the broadcasts against a legacy server', async () => {
    fake.legacy = true;
    fake.handlers['coach.ask'] = (_m, { broadcast }) => {
      broadcast({ type: 'ask.state', kind: 'suggest', phase: 'started' });
      after(20, () => {
        broadcast({ type: 'coach.suggestion', suggestion: card });
        broadcast({ type: 'ask.state', kind: 'suggest', phase: 'done', title: card.headline, body: card.phrasing });
      });
    };
    const r = await callTool('suggest', {}, opts);
    expect(r.structuredContent).toMatchObject({ suggestion: { id: 'c1' }, correlated: 'heuristic' });
  });
});

describe('research', () => {
  function suggested(broadcast: (m: Msg) => void, id: string, type: string, prompt: string) {
    broadcast({ type: 'action.suggested', action: { id, type, title: `${type.charAt(0).toUpperCase()}${type.slice(1)}: ${prompt}`, description: prompt, triggerQuote: '', estimatedDurationSec: 30, state: 'suggested', createdAt: new Date().toISOString() } });
  }

  it('fast=true triggers fast-research and returns the finished artifact', async () => {
    fake.handlers['action.trigger'] = (m, { reply, broadcast }) => {
      suggested(broadcast, 'act-1', m.actionType, m.prompt);
      reply({ type: 'request.ack', requestId: m.requestId, ok: true, actionId: 'act-1', actionType: m.actionType });
      broadcast({ type: 'action.status', actionId: 'act-1', state: 'running' });
      after(20, () => broadcast({ type: 'action.stream', actionId: 'act-1', delta: 'Acme raised ' }));
      after(40, () => broadcast({ type: 'action.status', actionId: 'act-1', state: 'completed', result: { success: true, data: { answer: 'short' }, summary: 'Fast research completed', artifacts: [{ type: 'markdown', content: 'Acme raised a $40M Series B in 2025.' }] } }));
    };
    const r = await callTool('research', { prompt: 'Acme funding', fast: true }, opts);
    expect(fake.received[0]).toMatchObject({ type: 'action.trigger', actionType: 'fast-research', prompt: 'Acme funding' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toBe('Acme raised a $40M Series B in 2025.');
    expect(r.structuredContent).toMatchObject({ actionId: 'act-1', state: 'completed', correlated: 'requestId' });
  });

  it('on timeout returns what streamed so far and says it is still running, with the action id', async () => {
    fake.handlers['action.trigger'] = (m, { reply, broadcast }) => {
      suggested(broadcast, 'act-2', m.actionType, m.prompt);
      reply({ type: 'request.ack', requestId: m.requestId, ok: true, actionId: 'act-2' });
      after(20, () => broadcast({ type: 'action.stream', actionId: 'act-2', delta: 'Partial findings so far.' }));
    };
    const t0 = Date.now();
    const r = await callTool('research', { prompt: 'Deep dive' }, { ...opts, timeouts: { ...opts.timeouts, research: 500 } });
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(fake.received[0]).toMatchObject({ actionType: 'research' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('Partial findings so far.');
    expect(r.content[0].text).toContain('still running in Meeting Copilot (action act-2)');
    expect(r.structuredContent).toMatchObject({ actionId: 'act-2', state: 'running', timedOut: true, partial: 'Partial findings so far.' });
  });

  it('follows its own action, not another client\'s that finishes first', async () => {
    fake.handlers['action.trigger'] = (m, { reply, broadcast }) => {
      // Another client triggered the SAME research a moment earlier.
      suggested(broadcast, 'other', m.actionType, m.prompt);
      suggested(broadcast, 'mine', m.actionType, m.prompt);
      reply({ type: 'request.ack', requestId: m.requestId, ok: true, actionId: 'mine' });
      after(10, () => broadcast({ type: 'action.status', actionId: 'other', state: 'completed', result: { success: true, artifacts: [{ type: 'markdown', content: 'NOT MINE' }] } }));
      after(60, () => broadcast({ type: 'action.status', actionId: 'mine', state: 'completed', result: { success: true, artifacts: [{ type: 'markdown', content: 'Mine.' }] } }));
    };
    const r = await callTool('research', { prompt: 'Same prompt' }, opts);
    expect(r.content[0].text).toBe('Mine.');
  });

  it('reports a failed card', async () => {
    fake.handlers['action.trigger'] = (m, { reply, broadcast }) => {
      reply({ type: 'request.ack', requestId: m.requestId, ok: true, actionId: 'act-3' });
      after(10, () => broadcast({ type: 'action.status', actionId: 'act-3', state: 'failed', result: { success: false, error: 'claude: ENOENT', summary: 'Research failed' } }));
    };
    const r = await callTool('research', { prompt: 'x' }, opts);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('ENOENT');
  });
});

describe('no live meeting / server down', () => {
  it.each([
    ['transcript', {}],
    ['ask', { question: 'q' }],
    ['pulse', { kind: 'checkin' }],
    ['suggest', {}],
    ['research', { prompt: 'p' }],
  ])('%s says no meeting is live and sends nothing', async (tool, args) => {
    fake.live = false;
    const r = await callTool(tool, args, opts);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(NO_MEETING);
    expect(fake.received).toEqual([]);
  });

  it.each(['status', 'transcript', 'ask', 'pulse', 'suggest', 'research'])('%s is a clear error when the server is down', async (tool) => {
    const endpoint = { socketPath: join(tmpdir(), 'no-such-copilot.sock'), port: 1 };
    const args: Msg = { question: 'q', kind: 'checkin', prompt: 'p' };
    const t0 = Date.now();
    const r = await callTool(tool, args, { endpoint, timeouts: { connect: 500 } });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Meeting Copilot isn't running/);
  });
});

describe('JSON-RPC', () => {
  it('initialize echoes a supported protocol version; tools/list lists exactly the six tools', async () => {
    const init = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'QuickAsk' } } });
    expect(init?.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'meeting-copilot' } });
    expect(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const list = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list?.result.tools.map((t: Msg) => t.name)).toEqual(['status', 'transcript', 'ask', 'pulse', 'suggest', 'research']);
    const unknown = await handleRpc({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
    expect(unknown?.error.code).toBe(-32601);
  });

  it('tools/call returns content + structuredContent', async () => {
    const r = await handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'status', arguments: {} } }, opts);
    expect(r?.result.content[0].type).toBe('text');
    expect(r?.result.structuredContent.live).toBe(true);
  });
});
