import { Specialist } from './specialist.types';

/**
 * Outbound email/messages. Needs contact resolution and mail lookup, and the
 * approval block because outbound mail is always held for the owner's one-click
 * approval before it is sent.
 */
export const emailSpecialist: Specialist = {
  intent: 'email',
  routerHint:
    'sending email/messages to people, drafting outbound, finding a contact address',
  tools: ['gmail_find_contact', 'gmail_search'],
  blocks: { approval: true },
};
