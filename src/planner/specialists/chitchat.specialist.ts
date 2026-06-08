import { Specialist } from './specialist.types';

/**
 * Casual talk / a general question with no action. No tools, no
 * assumptions/confidence/approval — but it KEEPS pending and learning on: a
 * casual-sounding message can still answer a pending item or state a durable
 * fact worth remembering.
 */
export const chitchatSpecialist: Specialist = {
  intent: 'chitchat',
  routerHint: 'casual talk, a general question, no action needed',
  tools: [],
  blocks: { assumptions: false, confidence: false, approval: false },
};
