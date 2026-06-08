/**
 * THE single source of truth for the planner's sub-agent/tool layer.
 *
 * A tool is described in exactly one place — this array. Everything else is
 * DERIVED from it so the three things that used to drift independently stay in
 * lockstep:
 *   1. the Zod enum the planner output is validated against (planner.schema.ts),
 *   2. the tool descriptions injected into the planner prompt (planner.prompt.ts),
 *   3. the routing from a requested tool name to its handler
 *      (orchestration.service.ts).
 *
 * Adding a tool = adding one entry here. The handler map in
 * OrchestrationService is typed `Record<ToolName, ...>`, so forgetting the
 * execution side is a COMPILE error, not a silent runtime bug.
 */
export const TOOLS = [
  {
    name: 'calendar_freebusy',
    description:
      'when you need to know if/when the owner is free. query = an ISO date (a single day), an ISO "start/end" range, or "" for the next 7 days.',
  },
  {
    name: 'calendar_agenda',
    description: 'when you need what\'s actually on the calendar. Same query format.',
  },
  {
    name: 'gmail_find_contact',
    description:
      'when you need someone\'s email to invite/email them. query = the person\'s name. (Found contacts are remembered automatically.)',
  },
  {
    name: 'gmail_search',
    description: 'to look up a fact in the owner\'s mail. query = Gmail search text.',
  },
  {
    name: 'web_research',
    description:
      'to research something on the web. query = the question. (May be unavailable; if findings say so, fall back to assume/ask.)',
  },
] as const;

export type ToolName = (typeof TOOLS)[number]['name'];

/** Tuple of tool names — feeds z.enum() and exhaustive handler typing. The
 *  literal tuple type is preserved so z.enum() yields the precise ToolName
 *  union (not just `string`). */
export const TOOL_NAMES = TOOLS.map((t) => t.name) as unknown as [
  ToolName,
  ...ToolName[],
];

/**
 * Bullet list of tools injected into the TOOLS section of the planner prompt.
 * Pass a subset to narrow the list to the tools a single specialist may request;
 * omit it (or pass undefined) for the full list (the monolithic behaviour). The
 * bullets always follow registry order, so a subset is a stable filter, not a
 * reordering.
 */
export function buildToolsPromptBlock(subset?: readonly ToolName[]): string {
  const tools = subset ? TOOLS.filter((t) => subset.includes(t.name)) : TOOLS;
  return tools.map((t) => `- ${t.name} — ${t.description}`).join('\n');
}

/**
 * The whole TOOLS section of the planner prompt — header, instruction, the
 * (optionally narrowed) bullet list, and the usage rules — as one block. A
 * specialist injects this with its own tool subset; passing no subset yields the
 * full section exactly as the monolithic prompt had it (the regression anchor).
 */
export function buildToolsSection(subset?: readonly ToolName[]): string {
  return `=== TOOLS (toolRequests) — search instead of asking ===
Emit toolRequests to resolve missing context, then you will be re-invoked with the findings appended to the prompt. Use them BEFORE asking the owner:
${buildToolsPromptBlock(subset)}
Rules: request only what you actually need; don't request a tool whose answer is already in the context or in the findings; don't re-request the same tool after it returned findings — at that point infer, assume, or ask. When you emit toolRequests, you may leave actions empty for this turn (you'll finalize them after the findings come back).`;
}

/** The `"a"|"b"|...` union string used in the JSON-schema example in the prompt. */
export function toolNamesUnion(): string {
  return TOOLS.map((t) => `"${t.name}"`).join('|');
}
