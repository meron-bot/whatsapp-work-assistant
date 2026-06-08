import { ToolName } from '../../orchestration/tool-registry';
import { PlannerIntent } from '../router/route.schema';

/**
 * A planner specialist — declarative. It does NOT write a prompt; it declares
 * which tools it may request and which shared blocks it needs, and the composer
 * (specialist.registry.ts) assembles the system prompt from the single-source
 * blocks. That keeps every specialist to a few lines and every cross-cutting
 * rule in exactly one place.
 */
export interface Specialist {
  readonly intent: PlannerIntent;

  /**
   * One short sentence telling the ROUTER when to pick this specialist. The
   * router's option list is derived from these, so this is the single source of
   * truth for routing too. '' means "not offered to the router" — used by
   * `general`, which is the fallback, never an explicitly chosen route.
   */
  readonly routerHint: string;

  /**
   * The tools this specialist is guided to request — narrows the TOOLS section
   * of its prompt. [] omits the TOOLS section entirely. This is guidance only:
   * the output schema's tool enum stays global, so a specialist can still
   * request a cross-domain tool when it genuinely needs one.
   */
  readonly tools: readonly ToolName[];

  /**
   * Which shared operational blocks to include. Defaults (applied by the
   * composer) keep a specialist behaving like the monolith unless it opts out:
   * assumptions/confidence/pending/learning default ON, approval defaults OFF
   * (only outward-facing routes turn it on).
   */
  readonly blocks?: {
    assumptions?: boolean; // default true
    approval?: boolean; // default false — only routes that act outward
    confidence?: boolean; // default true
    pending?: boolean; // default true
    learning?: boolean; // default true
  };
}
