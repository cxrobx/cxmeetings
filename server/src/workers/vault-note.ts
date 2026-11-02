import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildMeetingFilename, parseAttendees } from './filename.js';
import { getVaultProfile } from './vaultProfile.js';

/**
 * Files the end-of-meeting summary as a vault note, but only for calls nothing
 * else wrote up. Both this app and the companion recorder can capture one call,
 * and when both saved, every call landed twice. So the recorder wins: a call it
 * covered gets no note here. The gate lives here and not in the settings
 * because whether a call was covered is only known once it ends.
 */

/** Below this there is nothing a summary can honestly say. */
export const MIN_NOTE_WORDS = 100;

/** A recording with no end time (it crashed, or is running) counts this long at most. */
const OPEN_RECORDING_LIMIT_MS = 12 * 60 * 60 * 1000;

const STAMP = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_session$/;

function recordingsRoot(): string {
  return getVaultProfile().recorderDir ?? join(homedir(), 'Documents', 'CXNotesRecordings');
}

function toMs(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/** A session folder's name is its UTC start, and it exists before the manifest is final. */
function stampToMs(name: string): number | undefined {
  const m = STAMP.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : undefined;
}

/**
 * True when the recorder has a session covering at least half of this call. Half,
 * not any overlap: the tail of the previous meeting often runs into this one.
 * An unreadable folder counts as not covered, because a duplicate note is
 * recoverable and a missing one is not.
 */
export async function coveredByRecorder(
  startMs: number,
  endMs: number,
  root: string = recordingsRoot(),
  now: number = Date.now(),
): Promise<boolean> {
  const length = endMs - startMs;
  if (length <= 0) return false;
  let names: string[];
  try {
    names = await readdir(join(root, 'recordings'));
  } catch {
    return false;
  }
  for (const name of names) {
    const stamped = stampToMs(name);
    if (stamped === undefined || stamped >= endMs) continue;
    let manifest: Record<string, unknown> = {};
    try {
      manifest = JSON.parse(await readFile(join(root, 'recordings', name, 'manifest.json'), 'utf-8'));
    } catch {
      // Still recording, or a manifest cut short: the folder name carries the start.
    }
    const start = toMs(manifest.startTime) ?? stamped;
    const end = toMs(manifest.endTime) ?? Math.min(now, start + OPEN_RECORDING_LIMIT_MS);
    if (Math.min(end, endMs) - Math.max(start, startMs) >= length / 2) return true;
  }
  return false;
}

function longDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** The first name the profile knows the user by, without the built-in "me" and "self". */
function selfName(): string | undefined {
  const name = [...getVaultProfile().selfNames].find((n) => n !== 'me' && n !== 'self');
  if (!name) return undefined;
  const first = name.split(/\s+/)[0];
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** The vault's note shape around the summary, marked with the session that wrote it. */
export function noteBody(sessionId: string, startMs: number, attendees: string | undefined, markdown: string): string {
  const people = [selfName(), ...parseAttendees(attendees)].filter((p): p is string => Boolean(p));
  const participants = people.length
    ? `## Participants\n${people.map((p) => `- ${p}`).join('\n')}\n\n`
    : '';
  const summary = markdown.replace(/^\s*#\s[^\n]*\n+/, '').trim();
  return `---\ncopilot_session: ${sessionId}\n---\n\n## Meeting Notes [${longDate(startMs)}]\n\n${participants}${summary}\n`;
}

async function writtenBySession(path: string, sessionId: string): Promise<boolean> {
  const head = (await readFile(path, 'utf-8')).slice(0, 200);
  return head.startsWith('---\n') && head.includes(`\ncopilot_session: ${sessionId}\n`);
}

/** Never replaces another note. A retry of the same session replaces its own. */
async function writeWithoutClobbering(dir: string, filename: string, sessionId: string, body: string): Promise<string> {
  const base = filename.replace(/\.md$/, '');
  for (let n = 1; n < 100; n++) {
    const path = join(dir, `${base}${n === 1 ? '' : ` ${n}`}.md`);
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(body, 'utf-8');
      await handle.close();
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (await writtenBySession(path, sessionId)) {
      await writeFile(path, body, 'utf-8');
      return path;
    }
  }
  throw new Error(`No free filename for ${base}`);
}

export interface MeetingNote {
  sessionId: string;
  title?: string;
  attendees?: string;
  startedAt: number;
  endedAt: number;
  transcript: string;
  markdown: string;
}

export type NoteOutcome = { filePath: string } | { skipped: string };

export async function fileMeetingNote(
  note: MeetingNote,
  meetingsDir: string = join(homedir(), 'Documents', 'CX', 'Meetings'),
  root?: string,
): Promise<NoteOutcome> {
  if (note.transcript.split(/\s+/).filter(Boolean).length < MIN_NOTE_WORDS) {
    return { skipped: 'the call was too short for a note' };
  }
  if (await coveredByRecorder(note.startedAt, note.endedAt, root)) {
    return { skipped: 'CXNotes recorded this call and files its note' };
  }
  await mkdir(meetingsDir, { recursive: true });
  // `<CATEGORY> <Who|Topic> <MM.DD.YY>.md`. Stays in `Meetings/`, because the
  // companion recorder owns routing notes to their folders.
  const filename = buildMeetingFilename({ title: note.title, attendees: note.attendees, startedAt: note.startedAt });
  const body = noteBody(note.sessionId, note.startedAt, note.attendees, note.markdown);
  return { filePath: await writeWithoutClobbering(meetingsDir, filename, note.sessionId, body) };
}
