import { TOOL_NAMES } from '../../orchestration/tool-registry';
import { Specialist } from './specialist.types';

/**
 * The regression anchor. All tools + every block in the canonical order ⇒ the
 * composed prompt is byte-identical to the previous monolithic prompt. This is
 * the fallback for cross-domain or low-confidence messages, so it must never lose
 * any capability. routerHint is '' because general is never an explicitly chosen
 * route — resolveIntent falls back to it.
 */
export const generalSpecialist: Specialist = {
  intent: 'general',
  routerHint: '',
  tools: [...TOOL_NAMES],
  blocks: { approval: true }, // assumptions/confidence/pending/learning default on
};
