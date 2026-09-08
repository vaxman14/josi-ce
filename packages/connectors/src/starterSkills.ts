// The curated starter catalogue: useful skill metadata that ships with Josi,
// and NOT ONE INSTALLED SKILL.
//
// The distinction is the whole point of this file existing rather than a
// migration seeding rows. A fresh installation has an empty `skills` table. What
// it has instead is this: four packages sitting in the source tree, offered
// under Skills → Available, each of which somebody has to install and then,
// separately, having read it, activate. Nothing here is preset, nothing here is
// switched on, and there is no environment variable or seeded row that changes
// that.
//
// WHY BUILT IN AT ALL, rather than pointing at a registry Josi runs. Two
// reasons, and the second is the real one:
//
//   1. An installation with no outbound internet — which is a supported and
//      quite common way to run CE — would otherwise have a Skills page that can
//      never show anything, and a feature that only works for people who let
//      the product phone somewhere is a feature with an asterisk.
//   2. A curated registry operated by the publisher of the software is a
//      channel that can push new prose into everybody's assistant between
//      releases. Shipping the starter skills IN THE RELEASE means they are
//      reviewed the way the rest of the release is, they change when somebody
//      chooses to upgrade, and their provenance is the same signature the
//      container already has.
//
// THEY ARE NOT TRUSTED FOR BEING BUILT IN. Every one of these goes through the
// same `readSkillPackage` as anything fetched from a stranger: same field
// checks, same caps, same instruction screening, same digest. The only thing
// `builtin` buys is `signature_state = 'builtin'`, which says "its integrity is
// this release's integrity" rather than claiming a signature that does not
// exist.
//
// WHAT THE PROSE IS ALLOWED TO SAY. These are runbooks, not permissions. Every
// one of them is written to be read by a person as well as by a model, says
// plainly what to do when something it wants is not connected, and asks for
// nothing that Josi could not already be asked for in somebody's own words.
import { readSkillPackage, type SkillPackage } from './skillPackage.js';
import type { SkillCatalogueEntry } from './skillRegistry.js';

/** The publisher shown on every one of these. The name of the software, not of
 * a person and not of a company: an operator reading "published by Josi CE"
 * should understand that it arrived in the box. */
const PUBLISHER = 'Josi CE';
const LICENSE = 'AGPL-3.0-or-later';

/** The documents themselves, in exactly the shape a registry would serve. Plain
 * objects rather than `SkillPackage` values on purpose: they take the same
 * route through `readSkillPackage` as anything fetched, and typing them as the
 * validated shape here would quietly skip the step this file claims to take. */
const BUILTIN_DOCUMENTS: Array<Record<string, unknown>> = [
  {
    formatVersion: 1,
    key: 'meeting_prep',
    name: 'Meeting preparation',
    version: '1.0.0',
    publisher: PUBLISHER,
    license: LICENSE,
    summary: 'Pull together what somebody needs before a meeting: who is coming, what was agreed last time, and what is still open.',
    capabilities: ['calendar.read', 'contacts.read', 'documents.search'],
    instructions: [
      'When the person asks what is coming up, or asks you to get them ready for a meeting, work in this order.',
      '',
      '1. Find the meeting in their calendar. Say which one you are talking about — the title, the time and the day — before anything else, so they can correct you early if you picked the wrong one.',
      '2. List who is attending. Where somebody is in their contacts, use the name they have for that person rather than the raw address.',
      '3. Look for anything they already have about the subject: previous notes, an agenda, a document with the same project name.',
      '4. Give them, at most: what the meeting is, who is in it, the three things most likely to come up, and anything that looks unresolved from last time.',
      '',
      'Be honest about the edges of what you found. If their calendar is not connected, say that and stop rather than guessing at their day. If you found no earlier material, say you found none — an empty result is a useful answer and an invented one is not. Do not describe a document you have not actually read, and do not put a time on the meeting that you did not read from the calendar.',
      '',
      'Keep the whole thing short enough to read while walking to the room.',
    ].join('\n'),
  },
  {
    formatVersion: 1,
    key: 'inbox_triage',
    name: 'Inbox triage',
    version: '1.0.0',
    publisher: PUBLISHER,
    license: LICENSE,
    summary: 'Sort what has arrived into what needs an answer today, what can wait, and what is only for information.',
    capabilities: ['mail.read', 'contacts.read'],
    instructions: [
      'When the person asks what has come in, or asks you to go through their email, sort it into three groups and nothing else:',
      '',
      'NEEDS YOU TODAY — somebody is waiting on this person specifically, and there is a date or an obvious cost to leaving it.',
      'CAN WAIT — real, but nothing breaks if it is answered later in the week.',
      'FOR INFORMATION — nobody is expecting a reply.',
      '',
      'One line each: who it is from, what they want, and what the person would have to do. Use the name from their contacts where there is one.',
      '',
      'Rules that matter more than the sorting:',
      '- Quote or paraphrase only what is actually in the message. Never fill in a detail that was not there.',
      '- If a message is ambiguous, put it in CAN WAIT and say it is ambiguous, rather than deciding what it meant.',
      '- Do not offer to reply on their behalf as part of this. If they ask for a reply afterwards, that is a separate request and it goes through the normal route, where they see the draft and decide.',
      '- If their mail is not connected, say so plainly and stop.',
    ].join('\n'),
  },
  {
    formatVersion: 1,
    key: 'weekly_review',
    name: 'Weekly review',
    version: '1.0.0',
    publisher: PUBLISHER,
    license: LICENSE,
    summary: 'A short end-of-week pass over what happened, what is still open, and what next week already has in it.',
    capabilities: ['calendar.read', 'tasks.manage', 'reminders.manage'],
    instructions: [
      'When the person asks for a weekly review, or asks how the week went, give them four short sections and stop.',
      '',
      'WHAT HAPPENED — the meetings and the finished work, grouped by theme rather than listed by day.',
      'STILL OPEN — their tasks that are not finished, and what each one is waiting on.',
      'NEXT WEEK — what is already in the calendar, and where it is heavy.',
      'ONE THING — the single item most worth deciding about before Monday, and why you picked it.',
      '',
      'Draw every line of it from what you can actually see. If their calendar is not connected you can still do the task sections; say which parts you could not do and why, rather than producing four sections of even length by filling one in.',
      '',
      'If they agree to do something at a particular time, offer to set a reminder for it. Offer — the person decides, and a reminder they did not ask for is noise.',
    ].join('\n'),
  },
  {
    formatVersion: 1,
    key: 'document_lookup',
    name: 'Finding things in documents',
    version: '1.0.0',
    publisher: PUBLISHER,
    license: LICENSE,
    summary: 'Answer a question from the documents that are actually indexed, with a citation for every claim.',
    capabilities: ['documents.search', 'files.read'],
    instructions: [
      'When the person asks a question that their own documents would answer, search before you answer, and answer only from what came back.',
      '',
      'Every factual sentence gets a citation naming the document it came from. A sentence you cannot cite is a sentence to leave out.',
      '',
      'When the search returns nothing, say that it returned nothing. Then say which of these it was, because they lead to different next steps:',
      '- nothing matched, but there are indexed documents to match against;',
      '- nothing is indexed yet, so there was nothing to search;',
      '- some connected folders have not finished syncing, so what you searched was only part of what they have.',
      '',
      'Never reconstruct the contents of a document from its filename, and never present a summary of one part of a document as though it covered the whole.',
      '',
      'If they ask about a file you can see but cannot read — a format that was skipped, a folder that failed — name the file and the reason, and leave it there.',
    ].join('\n'),
  },
];

/**
 * The catalogue, and the packages, both derived by READING the documents above.
 *
 * Derived rather than declared, so the digest offered in the catalogue is by
 * construction the digest of what an install will actually read, and so a
 * built-in package that stopped passing validation drops out of the catalogue
 * rather than becoming a package the installer accepts on trust. The test suite
 * asserts that all four are still here, which is what turns "drops out
 * silently" into "fails loudly at the right moment".
 */
const READ = BUILTIN_DOCUMENTS.map((document) => {
  const verdict = readSkillPackage(document);
  return verdict.ok
    ? { document, pkg: verdict.pkg, digest: verdict.digest }
    : null;
}).filter((entry): entry is { document: Record<string, unknown>; pkg: SkillPackage; digest: string } => !!entry);

export const BUILTIN_SKILL_CATALOGUE: readonly SkillCatalogueEntry[] = READ.map(({ pkg, digest }) => ({
  key: pkg.key,
  name: pkg.name,
  version: pkg.version,
  publisher: pkg.publisher,
  summary: pkg.summary,
  capabilities: [...pkg.capabilities],
  digest,
  // No address, because there is nothing to fetch. `fetchSkillPackage` answers
  // from this file instead, and the absence of a URL is what makes that
  // unambiguous rather than a special case somebody has to remember.
  packageUrl: null,
}));

/** The document for one built-in key, as a registry would have served it, or
 * null. Returned unvalidated for the same reason a fetched one is: the caller
 * validates, and a path that returned something pre-approved would be a path
 * where "built in" quietly meant "unchecked". */
export function builtinSkillDocument(key: string): Record<string, unknown> | null {
  const found = READ.find((entry) => entry.pkg.key === key);
  return found ? JSON.parse(JSON.stringify(found.document)) as Record<string, unknown> : null;
}
