import { Specialist } from './specialist.types';

/**
 * Calendar / scheduling. Needs availability + agenda lookups and contact
 * resolution (to invite people), and the approval block because inviting an
 * external guest is an outward-facing action.
 */
export const scheduleSpecialist: Specialist = {
  intent: 'schedule',
  routerHint:
    'meetings, calendar, availability, reminders, time-blocking, moving/finding a slot',
  tools: ['calendar_freebusy', 'calendar_agenda', 'gmail_find_contact'],
  blocks: { approval: true },
};
