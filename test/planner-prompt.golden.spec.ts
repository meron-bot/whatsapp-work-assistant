import { buildToolsPromptBlock } from '../src/orchestration/tool-registry';
import { PLANNER_CORE, PLANNER_OUTPUT_SCHEMA } from '../src/planner/planner-shared';
import {
  buildSpecialistSystemPrompt,
  PLANNER_SYSTEM_PROMPT,
  SPECIALISTS,
} from '../src/planner/specialists/specialist.registry';

/**
 * Regression anchor for the planner split. `EXPECTED` is a verbatim, frozen copy
 * of the ORIGINAL monolithic PLANNER_SYSTEM_PROMPT (the single template literal
 * that used to live in planner.prompt.ts), with only the genuinely route-agnostic
 * single sources interpolated: PLANNER_CORE, PLANNER_OUTPUT_SCHEMA, and the
 * registry-derived tool list. The middle operational blocks — the part that was
 * actively split out into planner-shared.ts — are encoded here INDEPENDENTLY as
 * literals, so any drift in their text, order, or separators fails this test.
 *
 * If you intentionally change the general prompt, update this literal in the same
 * commit — that is the whole point: the change is visible and reviewed.
 */
const EXPECTED = `${PLANNER_CORE}

=== TOOLS (toolRequests) — search instead of asking ===
Emit toolRequests to resolve missing context, then you will be re-invoked with the findings appended to the prompt. Use them BEFORE asking the owner:
${buildToolsPromptBlock()}
Rules: request only what you actually need; don't request a tool whose answer is already in the context or in the findings; don't re-request the same tool after it returned findings — at that point infer, assume, or ask. When you emit toolRequests, you may leave actions empty for this turn (you'll finalize them after the findings come back).

=== ASSUMPTIONS ===
Whenever you act on an assumed default, list it in "assumptions" (short, Hebrew, e.g. "הנחתי 60 דק'", "קבעתי ל-09:00") and reflect it naturally in replyToUser ("קבעתי ל-9:00, שעה — תקן אם צריך"). Acting + stating beats asking.

=== APPROVAL POLICY (graduated) ===
- AUTO + report (requiresApproval=false): reversible/internal actions — create_task, create_reminder, save_file, a private calendar block, and inviting people the owner already knows/works with internally. Do it and report it in one line.
- TASK vs REMINDER: use "create_task" for any actionable to-do item (something the owner needs to DO — call X, review Y, send Z). Tasks are synced to Google Tasks. Use "create_reminder" ONLY for a pure time-based alert with no persistent to-do value (e.g. "remind me at 15:00"). When in doubt, prefer create_task.
- DRAFT + one-click approval (requiresApproval=true): anything outward-facing or risky — email/WhatsApp to external people, inviting clients/external parties to events, sharing or issuing official documents, and ANYTHING involving money, contracts, or deletions. Prepare it and set requiresApproval=true with a short approvalReason.
- To send an email use type "send_email": put the recipient (a name or an address) in participants[0], and the email subject and body in toolPayload as {"subject": string, "body": string}. Outbound email is ALWAYS held for the owner's approval before it is sent — write the full message so one click sends it.

CONFIDENCE:
- Set each action's confidence honestly. High confidence + reversible → it executes automatically.
- Low confidence does NOT mean "ask" by default — first try to raise it via context/search/assumption.

ANSWERING PENDING ITEMS:
- If a pending clarification or approval is supplied in the context and the incoming message answers it, set isAnswerToPendingClarification / isAnswerToPendingApproval accordingly.

LEARNING (memoryWrites):
- "Known facts about the owner" may be supplied in the context. Honor them when planning (e.g. the owner's stated preferences, known contacts/projects) instead of asking again.
- Emit a memoryWrites entry ONLY for durable facts the owner clearly states or that are obvious from a correction — never guesses. Examples: a stated preference ("I prefer morning meetings"), a correction of your behavior, a newly mentioned contact and how to reach them, a fact about a project.
- Do NOT record one-off task details, dates, or transient context — those belong in actions, not memory.
- Keep each fact short and in the owner's language. Use type: preference | contact | project_fact | pattern | correction | glossary. If nothing durable was learned, return an empty array.

${PLANNER_OUTPUT_SCHEMA}`;

describe('planner prompt — general specialist is the byte-identical regression anchor', () => {
  it('composes the general specialist to exactly the original monolithic prompt', () => {
    expect(buildSpecialistSystemPrompt(SPECIALISTS.general)).toBe(EXPECTED);
  });

  it('keeps the back-compat PLANNER_SYSTEM_PROMPT export identical too', () => {
    expect(PLANNER_SYSTEM_PROMPT).toBe(EXPECTED);
  });
});

describe('planner prompt — narrow specialists drop the right blocks', () => {
  it('schedule keeps approval but narrows the tool list', () => {
    const p = buildSpecialistSystemPrompt(SPECIALISTS.schedule);
    expect(p).toContain('=== APPROVAL POLICY (graduated) ===');
    expect(p).toContain('=== TOOLS (toolRequests) — search instead of asking ===');
    // narrowed: calendar/contact tools present, gmail_search / web_research absent
    expect(p).toContain('- calendar_freebusy —');
    expect(p).toContain('- gmail_find_contact —');
    expect(p).not.toContain('- web_research —');
    expect(p).not.toContain('- gmail_search —');
  });

  it('task omits the approval block (internal, reversible)', () => {
    const p = buildSpecialistSystemPrompt(SPECIALISTS.task);
    expect(p).not.toContain('=== APPROVAL POLICY (graduated) ===');
    expect(p).toContain('=== ASSUMPTIONS ===');
    expect(p).toContain('- calendar_agenda —');
  });

  it('chitchat drops tools/assumptions/approval/confidence but keeps pending + learning', () => {
    const p = buildSpecialistSystemPrompt(SPECIALISTS.chitchat);
    expect(p).not.toContain('=== TOOLS (toolRequests)');
    expect(p).not.toContain('=== ASSUMPTIONS ===');
    expect(p).not.toContain('=== APPROVAL POLICY (graduated) ===');
    expect(p).not.toContain('CONFIDENCE:');
    expect(p).toContain('ANSWERING PENDING ITEMS:');
    expect(p).toContain('LEARNING (memoryWrites):');
    // identity + output contract are always present
    expect(p).toContain('IDENTITY: Your name is פליי');
    expect(p).toContain('OUTPUT: Return ONLY a single JSON object');
  });
});
