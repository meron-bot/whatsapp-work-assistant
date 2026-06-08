import { Specialist } from './specialist.types';

/**
 * To-dos / prioritization / breaking work down. Usually internal and reversible,
 * so it keeps the default blocks (assumptions/confidence/pending/learning) and no
 * approval block. Calendar agenda helps it slot follow-ups against real days.
 */
export const taskSpecialist: Specialist = {
  intent: 'task',
  routerHint: 'to-dos, tasks, prioritization, breaking work down, follow-ups',
  tools: ['calendar_agenda'],
};
