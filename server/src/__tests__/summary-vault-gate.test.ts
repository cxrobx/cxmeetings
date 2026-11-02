import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fileMeetingNote = vi.fn();
vi.mock('../workers/vault-note.js', () => ({ fileMeetingNote }));
vi.mock('../claude-cli.js', () => ({ claudeSuggest: vi.fn(async () => '# Meeting Notes\n\n## Summary\nDone.') }));
const settings = { summaryAutoWrite: true };
vi.mock('../settings.js', () => ({ getSettings: () => settings }));

const { SummaryWorker } = await import('../workers/summary.js');
const run = (params: object) =>
  new SummaryWorker().execute({ transcript: 'words', ...params }, new AbortController().signal);

beforeEach(() => {
  settings.summaryAutoWrite = true;
  fileMeetingNote.mockResolvedValue({ filePath: '/vault/note.md' });
});
afterEach(() => vi.clearAllMocks());

describe('SummaryWorker vault gate', () => {
  it('files the end-of-meeting summary', async () => {
    const result = await run({ vaultNote: true, sessionId: 's', endedAt: 2, startedAt: 1 });
    expect(fileMeetingNote).toHaveBeenCalledOnce();
    expect(result.data.filePath).toBe('/vault/note.md');
  });

  it('never files a rolling or manual summary', async () => {
    await run({ scope: 'full', _rolling: true });
    expect(fileMeetingNote).not.toHaveBeenCalled();
  });

  it('never files a rehearsal', async () => {
    await run({ vaultNote: false, sessionId: 's', endedAt: 2 });
    expect(fileMeetingNote).not.toHaveBeenCalled();
  });

  it('respects the setting', async () => {
    settings.summaryAutoWrite = false;
    await run({ vaultNote: true, sessionId: 's', endedAt: 2 });
    expect(fileMeetingNote).not.toHaveBeenCalled();
  });

  it('says why when it skipped, and still returns the summary', async () => {
    fileMeetingNote.mockResolvedValue({ skipped: 'CXNotes recorded this call and files its note' });
    const result = await run({ vaultNote: true, sessionId: 's', endedAt: 2 });
    expect(result.success).toBe(true);
    expect(result.summary).toContain('CXNotes recorded this call');
    expect(result.data.markdown).toContain('Done.');
  });
});
