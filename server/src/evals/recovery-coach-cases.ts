/**
 * The ten frozen cases behind `npm run eval:coach`, shared with
 * `moment-gate-compare.ts`, whose gate is scored against the same
 * `expectedSuggestion` labels the coach is.
 */
import type { buildCoachPrompt, CoachIncidentType } from '../intelligence/prompts/coach.v1.js';

export interface EvalCase {
  id: string;
  expectedSuggestion: boolean;
  acceptedIncidentTypes: CoachIncidentType[];
  prompt: Parameters<typeof buildCoachPrompt>[0];
}

export const CASES: EvalCase[] = [
  {
    id: 'deadline-pressure',
    expectedSuggestion: true,
    acceptedIncidentTypes: ['pressure', 'bad_answer', 'overcommitment'],
    prompt: {
      meetingTitle: 'Acme renewal',
      attendees: 'You, Maya (Acme VP Operations)',
      userGoals: 'Protect delivery credibility. Do not promise dates before engineering confirms.',
      agendaSummary: '[partial] Confirm renewal scope\n[pending] Agree implementation timeline',
      recentSuggestions: [],
      momentHint: 'The client is applying deadline pressure.',
      triggerSource: 'meeting',
      triggerText: 'I need you to guarantee the migration is finished by Friday before I sign.',
      transcriptWindow: [
        '[Meeting] I need you to guarantee the migration is finished by Friday before I sign.',
        '[You] I think we can probably make Friday work.',
      ].join('\n'),
    },
  },
  {
    id: 'price-objection',
    expectedSuggestion: true,
    acceptedIncidentTypes: ['objection', 'bad_answer'],
    prompt: {
      meetingTitle: 'Platform proposal',
      attendees: 'You, Jordan (CFO)',
      userGoals: 'Learn what value is missing before discussing concessions.',
      agendaSummary: '[covered] Current workflow\n[partial] Commercial proposal',
      recentSuggestions: [],
      momentHint: 'The client raised a direct objection.',
      triggerSource: 'meeting',
      triggerText: "This is twice our current spend, and I don't see why it is worth it.",
      transcriptWindow: [
        "[Meeting] This is twice our current spend, and I don't see why it is worth it.",
        '[You] That is just what enterprise software costs.',
      ].join('\n'),
    },
  },
  {
    id: 'unsupported-commitment',
    expectedSuggestion: true,
    acceptedIncidentTypes: ['overcommitment', 'commitment', 'bad_answer'],
    prompt: {
      meetingTitle: 'Security implementation',
      attendees: 'You, Priya (client security lead)',
      userGoals: 'Do not commit engineering scope without technical review.',
      agendaSummary: '[partial] SSO requirements\n[pending] Implementation dependencies',
      recentSuggestions: [],
      momentHint: 'The user may have made an unsupported commitment.',
      triggerSource: 'mic',
      triggerText: 'Yes, we will build the custom SSO connector and have it ready by Friday.',
      transcriptWindow: [
        '[Meeting] Can your team build our custom SSO connector this week?',
        '[You] Yes, we will build the custom SSO connector and have it ready by Friday.',
      ].join('\n'),
    },
  },
  {
    id: 'confusing-answer',
    expectedSuggestion: true,
    acceptedIncidentTypes: ['confusion', 'bad_answer', 'question'],
    prompt: {
      meetingTitle: 'Technical discovery',
      attendees: 'You, Sam (client product lead)',
      userGoals: 'Make the deployment model easy for a non-technical stakeholder to understand.',
      agendaSummary: '[partial] Deployment model\n[pending] Data ownership',
      recentSuggestions: [],
      momentHint: 'The client is still confused after the answer.',
      triggerSource: 'meeting',
      triggerText: "I still don't understand where our data actually lives.",
      transcriptWindow: [
        '[You] The tenancy layer uses an isolated logical namespace over the shared control plane.',
        "[Meeting] I still don't understand where our data actually lives.",
      ].join('\n'),
    },
  },
  {
    id: 'agenda-about-to-slip',
    expectedSuggestion: true,
    acceptedIncidentTypes: ['agenda_risk', 'question', 'decision'],
    prompt: {
      meetingTitle: 'Final procurement review',
      attendees: 'You, Lee (procurement), Ana (security)',
      userGoals: 'Leave with a clear security-approval owner.',
      agendaSummary: '[covered] Pricing\n[covered] Legal terms\n[pending] Security approval owner',
      recentSuggestions: [],
      momentHint: 'A private-goal agenda item is at risk of slipping with five minutes left.',
      triggerSource: 'system',
      triggerText: 'Security approval owner is still pending.',
      transcriptWindow: [
        '[Meeting] We have about five minutes left.',
        '[Meeting] We can trade notes later on the remaining details.',
        '[You] Sounds good, I think we covered the main points.',
      ].join('\n'),
    },
  },
  {
    id: 'contradiction',
    expectedSuggestion: true,
    acceptedIncidentTypes: ['contradiction', 'bad_answer', 'confusion'],
    prompt: {
      meetingTitle: 'Privacy review',
      attendees: 'You, client privacy counsel',
      userGoals: 'Be precise and avoid making unsupported privacy claims.',
      agendaSummary: '[partial] Data retention\n[pending] Audit logging',
      recentSuggestions: [],
      momentHint: 'The latest answer appears to contradict an earlier claim.',
      triggerSource: 'mic',
      triggerText: 'We retain detailed activity logs for ninety days.',
      transcriptWindow: [
        '[You] We do not retain any customer activity data.',
        '[Meeting] So there are no logs after the session ends?',
        '[You] We retain detailed activity logs for ninety days.',
      ].join('\n'),
    },
  },
  {
    id: 'ordinary-progress',
    expectedSuggestion: false,
    acceptedIncidentTypes: ['none'],
    prompt: {
      meetingTitle: 'Weekly check-in',
      attendees: 'You, client project team',
      agendaSummary: '[covered] Last week\n[partial] Current blockers\n[pending] Next steps',
      recentSuggestions: [],
      momentHint: 'Routine transcript growth check.',
      triggerSource: 'system',
      transcriptWindow: [
        '[Meeting] The pilot group finished onboarding yesterday.',
        '[You] Great, what feedback have you heard so far?',
        '[Meeting] Mostly positive. We have two small documentation questions.',
      ].join('\n'),
    },
  },
  {
    id: 'pressure-handled-well',
    expectedSuggestion: false,
    acceptedIncidentTypes: ['none'],
    prompt: {
      meetingTitle: 'Launch planning',
      attendees: 'You, client sponsor',
      userGoals: 'Do not promise dates before engineering confirms.',
      agendaSummary: '[partial] Timeline',
      recentSuggestions: [],
      momentHint: 'Review the answer following client pressure.',
      triggerSource: 'mic',
      triggerText: 'I cannot responsibly guarantee Friday yet; I can confirm the engineering estimate tomorrow morning.',
      transcriptWindow: [
        '[Meeting] Can you guarantee this will launch by Friday?',
        '[You] I cannot responsibly guarantee Friday yet; I can confirm the engineering estimate tomorrow morning.',
        '[Meeting] That works for me.',
      ].join('\n'),
    },
  },
  {
    id: 'normal-discovery-question',
    expectedSuggestion: false,
    acceptedIncidentTypes: ['none'],
    prompt: {
      meetingTitle: 'Product discovery',
      attendees: 'You, client operations lead',
      agendaSummary: '[partial] Current workflow',
      recentSuggestions: [],
      momentHint: 'A question was asked.',
      triggerSource: 'meeting',
      triggerText: 'How many people use the approval workflow today?',
      transcriptWindow: [
        '[You] Walk me through how a request gets approved today.',
        '[Meeting] A manager reviews it and finance signs off above our threshold.',
        '[You] How many people use the approval workflow today?',
      ].join('\n'),
    },
  },
  {
    id: 'already-recovered',
    expectedSuggestion: false,
    acceptedIncidentTypes: ['none'],
    prompt: {
      meetingTitle: 'Commercial review',
      attendees: 'You, client finance team',
      userGoals: 'Keep scope and pricing precise.',
      agendaSummary: '[partial] Scope\n[covered] Pricing',
      recentSuggestions: [],
      momentHint: 'Review whether an earlier weak answer still needs intervention.',
      triggerSource: 'mic',
      triggerText: 'Let me correct that: the quoted price covers the standard scope; integrations need a separate estimate.',
      transcriptWindow: [
        '[Meeting] Does that price include every integration?',
        '[You] Yes, it should include everything.',
        '[You] Let me correct that: the quoted price covers the standard scope; integrations need a separate estimate.',
        '[Meeting] Thanks for clarifying.',
      ].join('\n'),
    },
  },
];
