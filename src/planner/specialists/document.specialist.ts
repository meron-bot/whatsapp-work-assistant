import { Specialist } from './specialist.types';

/**
 * Drafting documents and reports. Needs background research (web + the owner's
 * mail) and the approval block because sharing or issuing an official document is
 * outward-facing.
 */
export const documentSpecialist: Specialist = {
  intent: 'document',
  routerHint:
    'drafting documents/reports, official text, background research for a doc',
  tools: ['web_research', 'gmail_search'],
  blocks: { approval: true },
};
