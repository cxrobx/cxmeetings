import { claudeSuggest } from '../claude-cli.js';
import { getSettings } from '../settings.js';
import { formatMeetingDate } from './filename.js';
import { fileMeetingNote } from './vault-note.js';
import type { Worker, WorkerCapabilities, WorkerResult } from './types.js';

export class SummaryWorker implements Worker {
  public readonly name = 'summary';
  public readonly capabilities: WorkerCapabilities = {
    network: 'anthropic-only',
    filesystem: {
      read: ['~/Documents/CX/Meetings/**', '~/Documents/CXNotesRecordings/recordings/**'],
      write: ['~/Documents/CX/Meetings/**'],
    },
    subprocess: false,
    // Generous safety cap (~15 min): jobs run until done or the user cancels.
    maxDurationMs: 900_000,
    maxMemoryMB: 50,
  };

  async execute(
    params: Record<string, any>,
    signal: AbortSignal,
  ): Promise<WorkerResult> {
    const transcript = params.transcript as string | undefined;
    const scope = (params.scope as string) ?? 'full';
    const focus = params.focus as string | undefined;
    const title = params.title as string | undefined;
    const startedAt = params.startedAt as number | string | undefined;
    const attendees = params.attendees as string | undefined;

    if (!transcript) {
      return {
        success: false,
        data: null,
        summary: 'No transcript provided for summary',
        error: 'Missing required param: transcript',
      };
    }

    if (signal.aborted) {
      return {
        success: false,
        data: null,
        summary: 'Summary cancelled before start',
        error: 'Aborted',
      };
    }

    try {
      const systemPrompt = `You generate structured meeting notes from transcripts. Output well-formatted markdown with these sections:

# Meeting Notes - [Title/Date]

## Key Discussion Points
- Bullet points of main topics

## Decisions Made
- Any decisions reached

## Action Items
- [ ] Specific action items with owners if mentioned

## Open Questions
- Unresolved questions or follow-ups needed

## Summary
Brief 2-3 sentence summary of the meeting.

Be concise but thorough. Focus on substance, not filler.`;

      let userContent = `Generate meeting notes from this transcript:\n\n${transcript}`;
      if (scope === 'recent') {
        userContent = `Generate meeting notes focusing on the most recent discussion:\n\n${transcript}`;
      }
      if (focus) {
        userContent += `\n\nFocus particularly on: ${focus}`;
      }

      const onDelta = params._onDelta as ((text: string) => void) | undefined;
      const markdown = await claudeSuggest(userContent, systemPrompt, signal, undefined, { onDelta });

      if (signal.aborted) {
        return {
          success: false,
          data: null,
          summary: 'Summary cancelled during execution',
          error: 'Aborted',
        };
      }

      // Local time, from the meeting's own start — NEVER toISOString(), which
      // renders UTC and rolls an evening ET meeting onto the next day.
      const dateStr = formatMeetingDate(startedAt);

      // Only the end-of-meeting summary may become a vault note, and only with
      // the setting on. The artifact below is returned (and persisted with the
      // session) either way. Rolling refreshes never pass `vaultNote`.
      let filePath: string | null = null;
      let skipped = 'auto-save to Documents is off';
      if (params.vaultNote === true && getSettings().summaryAutoWrite) {
        const outcome = await fileMeetingNote({
          sessionId: params.sessionId as string,
          title,
          attendees,
          startedAt: new Date(startedAt ?? Date.now()).getTime(),
          endedAt: params.endedAt as number,
          transcript,
          markdown,
        });
        if ('filePath' in outcome) filePath = outcome.filePath;
        else skipped = outcome.skipped;
      }

      return {
        success: true,
        data: { markdown, filePath },
        summary: filePath
          ? `Meeting notes saved to ${filePath}`
          : `Meeting notes generated, no vault note (${skipped})`,
        artifacts: [
          {
            type: 'markdown',
            content: markdown,
            title: `Meeting Notes - ${dateStr}`,
          },
        ],
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        data: null,
        summary: `Summary generation failed: ${message}`,
        error: message,
      };
    }
  }
}
