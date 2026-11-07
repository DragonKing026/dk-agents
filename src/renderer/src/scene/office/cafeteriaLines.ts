// Cafeteria small-talk.
//
// An agent's coffee break is an excuse for a short office one-liner. Two kinds
// of line:
//   • solo  — one quip shown above a single agent at a break spot
//   • pair  — a two-beat (or longer) exchange between two agents at one table
//
// Lines are kept short so they fit the ThoughtBubble (≈MAX_WIDTH). The pools are
// shared by every character; the character argument stays in the signatures so
// per-character lines can be added later without touching the callers.

import type { OfficeCharacterName } from './cast';

/** Where an agent is lingering — picks a contextual line pool. */
export type BreakSpot = 'coffee' | 'vending' | 'snack' | 'table';

const pick = <T,>(arr: readonly T[], seed: number): T =>
  arr[((seed % arr.length) + arr.length) % arr.length];

// ─── solo lines, by spot ─────────────────────────────────────────────────────

const COFFEE: readonly string[] = [
  'is this… decaf?? who did this',
  "we're out of beans again",
  'first cup of the day. and the fifth.',
  'the coffee here is basically a hug',
  'who took my mug?',
];

const VENDING: readonly string[] = [
  'the machine ate my coin',
  'B4… please be the pretzels',
  'it’s stuck. classic.',
  'shaking it. gently. respectfully.',
  'one (1) emotional-support snack',
];

const SNACK: readonly string[] = [
  'who finished the chips??',
  'just a little treat',
  'second breakfast',
  'these are for everyone? great',
];

const TABLE: readonly string[] = [
  'big day. lots of meetings.',
  'just five more minutes',
  'did you see the standup notes?',
  'pretending to read my notes',
  'I needed this break, honestly',
];

const SPOT_POOL: Record<BreakSpot, readonly string[]> = {
  coffee: COFFEE, vending: VENDING, snack: SNACK, table: TABLE,
};

/** A solo break-room line that fits the spot the agent is standing at. `seed`
 *  keeps it deterministic per call site (avoids Math.random, which
 *  Pixi/Electron CSP-safe code prefers). */
export function pickSoloLine(_character: OfficeCharacterName, spot: BreakSpot, seed: number): string {
  return pick(SPOT_POOL[spot], seed);
}

// ─── paired exchanges (two agents at one table) ──────────────────────────────
//
// Each exchange is a list of beats that ALTERNATE between the two agents:
// beat[0] = the speaker who sat down, beat[1] = their table-mate, beat[2] =
// speaker again, and so on. The director plays them out one beat at a time.
// Lines are trimmed to fit the thought cloud; longer ones auto-truncate.

type Exchange = readonly string[];

const EXCHANGES: readonly Exchange[] = [
  ['standup ran 40 minutes.', 'could’ve been an email.'],
  ['is the build green yet?', '...don’t look.'],
  ['who reply-all’d everyone?', 'we don’t talk about it.'],
  ['is a hot dog a sandwich?', 'it is.', 'I know, right?'],
  ['what do we ship again?', 'tickets.', 'sure, yeah.'],
  ['cats are better than dogs.', 'dogs are better.', '...agree to disagree.'],
  ['did you just roll your eyes?', 'I did.', 'why?', 'muscle memory.'],
  ['I’ve watched that clock since four.', 'weren’t you working?', 'multitasking.'],
  ['that’s not how math works.', 'I know.', 'then why?', 'faster.'],
  ['sign this.', 'what is it?', 'doesn’t matter.', '...fine.'],
  ['you can’t say that.', 'I just did.', 'gonna stop me?', '...no.'],
  ['are you okay?', 'I’ve been worse.', 'when?', 'can’t narrow it down.'],
  ['there’s a spider on your desk.', 'where?', '...never mind.'],
  ['did you miss me?', 'no.', 'a little?', '...a little.'],
  ['I love Fridays.', 'it’s Tuesday.', 'I love Fridays.'],
  ['who moved my stapler?', 'nobody.', 'it was here.', 'it still is.'],
  ['one more meeting.', 'you said that at ten.', 'I meant it then too.'],
  ['quick question.', 'yes.', 'never mind, I found it.'],
  ['the printer is jammed.', 'again?', 'it has opinions.'],
  ['I’m not procrastinating.', 'you’re at the coffee machine.', 'researching.'],
  ['nice weather.', 'we’re inside.', 'I looked it up.'],
  ['do you ever clear your inbox?', 'no.', 'good. me neither.'],
  ['I read the whole spec.', 'all of it?', 'the title. I read the title.'],
  ['it works on my machine.', 'ship your machine then.', '...working on it.'],
];

/** A multi-beat exchange for two agents sharing a table. Beats alternate:
 *  index 0 = `speaker`, 1 = the table-mate, 2 = speaker, … */
export function pickExchange(_speaker: OfficeCharacterName, seed: number): Exchange {
  return pick(EXCHANGES, seed);
}
