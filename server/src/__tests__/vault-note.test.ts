import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coveredByRecorder, fileMeetingNote, MIN_NOTE_WORDS, noteBody } from '../workers/vault-note.js';
import { _setVaultProfileForTests } from '../workers/vaultProfile.js';

const START = Date.UTC(2026, 10, 2, 15, 0, 0);
const HOUR = 3_600_000;
const END = START + HOUR;
const LONG = Array(MIN_NOTE_WORDS).fill('word').join(' ');

let root: string;
let recordings: string;
let meetings: string;

function recording(name: string, manifest?: unknown): void {
  const dir = join(recordings, 'recordings', name);
  mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) writeFileSync(join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
}

const iso = (ms: number) => new Date(ms).toISOString();
const note = (over: object = {}) => ({
  sessionId: 'session-1', title: 'Roadmap', attendees: 'Alex, Sam', startedAt: START, endedAt: END,
  transcript: LONG, markdown: '# Meeting Notes - Roadmap\n\n## Summary\nDone.', ...over,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-note-'));
  recordings = join(root, 'recorder');
  meetings = join(root, 'Meetings');
  _setVaultProfileForTests({ selfNames: ['morgan', 'morgan lee'] });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  _setVaultProfileForTests(null);
  vi.restoreAllMocks();
});

describe('coveredByRecorder', () => {
  it('counts a recording that spans the call', async () => {
    recording('2026-11-02_14-59-00_session', { startTime: iso(START - 60_000), endTime: iso(END + 60_000) });
    expect(await coveredByRecorder(START, END, recordings)).toBe(true);
  });

  it('ignores the tail of the previous meeting', async () => {
    recording('2026-11-02_14-00-00_session', { startTime: iso(START - HOUR), endTime: iso(START + 5 * 60_000) });
    expect(await coveredByRecorder(START, END, recordings)).toBe(false);
  });

  it('counts a recording still running, from its folder name alone', async () => {
    recording('2026-11-02_15-01-00_session');
    expect(await coveredByRecorder(START, END, recordings, END)).toBe(true);
  });

  it('survives a truncated manifest', async () => {
    recording('2026-11-02_15-01-00_session', '{"startTime":');
    expect(await coveredByRecorder(START, END, recordings, END)).toBe(true);
  });

  it('does not let a crashed recording cover every later call', async () => {
    const crashed = START - 3 * 24 * HOUR;
    recording('2026-10-30_15-00-00_session', { startTime: iso(crashed) });
    expect(await coveredByRecorder(START, END, recordings, END)).toBe(false);
  });

  it('treats a missing folder as not covered', async () => {
    expect(await coveredByRecorder(START, END, join(root, 'nothing'))).toBe(false);
  });
});

describe('noteBody', () => {
  it('uses the vault shape, with the user first and no second title', () => {
    const body = noteBody('session-1', START, 'Alex, Morgan Lee, Sam', '# Meeting Notes - Roadmap\n\n## Summary\nDone.');
    expect(body).toContain('copilot_session: session-1');
    expect(body).toContain('## Meeting Notes [2 November 2026]');
    expect(body).toContain('## Participants\n- Morgan\n- Alex\n- Sam\n\n## Summary');
    expect(body).not.toContain('# Meeting Notes - Roadmap');
  });

  it('leaves the block out when nobody is known', () => {
    _setVaultProfileForTests({});
    expect(noteBody('s', START, undefined, '## Summary\nDone.')).not.toContain('## Participants');
  });
});

describe('fileMeetingNote', () => {
  it('writes a note for a call nothing else recorded', async () => {
    const outcome = await fileMeetingNote(note(), meetings, recordings);
    expect(outcome).toHaveProperty('filePath');
    const [name] = readdirSync(meetings);
    expect(name).toMatch(/ 11\.02\.26\.md$/);
    expect(readFileSync(join(meetings, name), 'utf-8')).toContain('## Summary\nDone.');
  });

  it('writes nothing for a call the recorder covered', async () => {
    recording('2026-11-02_15-00-00_session', { startTime: iso(START), endTime: iso(END) });
    expect(await fileMeetingNote(note(), meetings, recordings)).toHaveProperty('skipped');
    expect(() => readdirSync(meetings)).toThrow();
  });

  it('writes nothing for a call too short to summarise', async () => {
    expect(await fileMeetingNote(note({ transcript: 'hello there' }), meetings, recordings)).toHaveProperty('skipped');
  });

  it('never overwrites a note it did not write', async () => {
    await fileMeetingNote(note(), meetings, recordings);
    const [name] = readdirSync(meetings);
    writeFileSync(join(meetings, name), 'a note someone wrote');
    const outcome = await fileMeetingNote(note(), meetings, recordings);
    expect(readFileSync(join(meetings, name), 'utf-8')).toBe('a note someone wrote');
    expect((outcome as { filePath: string }).filePath).toMatch(/ 11\.02\.26 2\.md$/);
  });

  it('gives a second session on the same day its own file', async () => {
    await fileMeetingNote(note(), meetings, recordings);
    await fileMeetingNote(note({ sessionId: 'session-2' }), meetings, recordings);
    expect(readdirSync(meetings)).toHaveLength(2);
  });

  it('lets a retry replace its own note', async () => {
    await fileMeetingNote(note(), meetings, recordings);
    await fileMeetingNote(note({ markdown: '## Summary\nBetter.' }), meetings, recordings);
    const files = readdirSync(meetings);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(meetings, files[0]), 'utf-8')).toContain('Better.');
  });
});
