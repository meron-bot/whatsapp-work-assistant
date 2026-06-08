# תוכנית מימוש — פיצול המתכנן ל-Router קל + מומחים

מסמך זה הוא תוכנית מימוש מפורטת לפירוק `PlannerService` המונוליטי ל**ניתוב קל (router) + מתכננים מומחים**, עם דגש על **מודולריות**: כל מומחה הוא יחידה עצמאית שאפשר לערוך לבד, והרכיבים מדברים דרך חוזים נקיים (single source of truth), בלי כפילויות ובלי drift.

> סטטוס תלות: #2 Tool Registry — קיים. שלב חילוץ הליבה (`PLANNER_CORE` / `PLANNER_OUTPUT_SCHEMA`) — בוצע. המסמך הזה הוא ההמשך (#4). לא חובה לבצע עכשיו — למשוך בהדק כשבלוק תפעולי של מסלול באמת גדל.
>
> **✅ מומש (2026-06-08).** כל ה-PR-ים (1–4) מומשו בענף הזה מאחורי הדגל `PLANNER_ROUTER_ENABLED` (ברירת מחדל `false` ⇒ אפס שינוי התנהגות; כל ההודעות עדיין דרך `general`). מבנה הקבצים: `planner-shared.ts`, `router/route.schema.ts`, `router/planner-router.{prompt,service}.ts`, `specialists/*`. עוגן הרגרסיה מאומת: `buildSpecialistSystemPrompt(SPECIALISTS.general)` זהה byte-for-byte למונוליט (טסט `test/planner-prompt.golden.spec.ts`). הדלקה: להגדיר `PLANNER_ROUTER_ENABLED=true` אחרי deploy ולצפות בכמה הודעות חיות; גלגול אחורה = כיבוי הדגל.

---

## 1. עקרונות התכנון (מה ה"אורגני" אומר בפועל)

1. **הפיצול פנימי ל-planning בלבד.** כל מומחה מחזיר את אותו `PlannerOutput`. כל מה שאחרי המתכנן (`action-policy`, `ActionExecutor`, ה-resolution loop) **לא נוגעים**. זה מה שהופך את כל המהלך לבטיח.
2. **כל בלוק טקסט = קבוע יחיד (single source).** עורכים מדיניות אישורים → משנים `APPROVAL_BLOCK` במקום אחד; כל מומחה שמשתמש בו מתעדכן. אפס כפילות.
3. **כל מומחה = קובץ אחד, הצהרתי.** לשנות התנהגות של "מתכנן יומן" = לערוך `schedule.specialist.ts` בלבד. להוסיף מומחה = קובץ + שורה ברישום; חוסר רישום = **שגיאת קומפילציה** (כמו ב-tool-registry).
4. **הרכיבים מדברים דרך הרישום.** ה-router לא יודע על מסלולים מקודדים-קשיח — הוא **נגזר** מהרישום (אותה כוונה שמוסיף מומחה גם מעדכנת את ה-router). זה ה"מדברים עם עצמם בצורה אידיאלית".
5. **המונוליט לא נזרק — הוא ה-fallback.** מסלול `general` = הפרומפט הנוכחי בדיוק (byte-identical). כל מה שלא מסווג בוודאות, או חוצה-תחומים, נופל אליו. אפס רגרסיה.
6. **מאחורי דגל.** `PLANNER_ROUTER_ENABLED=false` כברירת מחדל → התנהגות זהה להיום. מדליקים כשבטוחים.

---

## 2. מבנה הקבצים (מודולרי)

```
src/planner/
  planner.module.ts            ← מתוקן: מוסיף PlannerRouterService ל-providers/exports
  planner.service.ts           ← מתוקן: בוחר מומחה לפי ctx.route, שומר על light→heavy
  planner.prompt.ts            ← מתוקן: נשאר רק buildPlannerUserPrompt + PlannerContextInput (+ route)
  planner-shared.ts            ← חדש: כל בלוקי הטקסט המשותפים כקבועים יחידים
  router/
    route.schema.ts            ← חדש: PLANNER_INTENTS + RouteDecision (Zod)  ← מקור-אמת לכוונות
    planner-router.prompt.ts   ← חדש: buildRouterSystemPrompt() — נגזר מהרישום
    planner-router.service.ts  ← חדש: classify(ctx) → RouteDecision  (לעולם לא זורק)
  specialists/
    specialist.types.ts        ← חדש: interface Specialist
    specialist.registry.ts     ← חדש: Record<PlannerIntent, Specialist> + buildSpecialistSystemPrompt + resolveIntent
    schedule.specialist.ts     ← חדש
    task.specialist.ts         ← חדש
    document.specialist.ts     ← חדש
    email.specialist.ts        ← חדש
    chitchat.specialist.ts     ← חדש
    general.specialist.ts      ← חדש: המונוליט (כל הבלוקים, סדר נוכחי) = עוגן רגרסיה
```

---

## 3. החוזים (Types) — לב המודולריות

### 3.1 קבוצת הכוונות = מקור-אמת יחיד (`router/route.schema.ts`)

מירר את התבנית של `tool-registry`: tuple אחד שממנו נגזרים גם ה-Zod enum, גם ה-`Record` של הרישום, וגם אפשרויות ה-router.

```ts
import { z } from 'zod';

export const PLANNER_INTENTS = [
  'schedule',   // פגישות/יומן/זמינות/תזכורות/time-blocking
  'task',       // משימות, תעדוף, פירוק, follow-up
  'document',   // ניסוח/הכנת מסמכים ודוחות, מחקר רקע
  'email',      // מייל/הודעות יוצאות, איתור איש קשר
  'chitchat',   // שיחה קלה / שאלה כללית — בלי פעולה
  'general',    // fallback: רב-תחומי / סיווג לא ודאי → המונוליט
] as const;

export type PlannerIntent = (typeof PLANNER_INTENTS)[number];

export const routeDecisionSchema = z.object({
  intent: z.enum(PLANNER_INTENTS),
  crossDomain: z.boolean().default(false),
  confidence: z.number().min(0).max(1),
});
export type RouteDecision = z.infer<typeof routeDecisionSchema>;
```

### 3.2 חוזה המומחה (`specialists/specialist.types.ts`)

הצהרתי — מומחה לא כותב פרומפט; הוא **מצהיר אילו בלוקים ואילו כלים** הוא צריך. ה-composer מרכיב.

```ts
import { ToolName } from '../../orchestration/tool-registry';
import { PlannerIntent } from '../router/route.schema';

export interface Specialist {
  readonly intent: PlannerIntent;
  /** משפט קצר ל-ROUTER: מתי לבחור במומחה הזה. נגזר → מקור-אמת יחיד גם לניתוב. '' = לא מוצע ל-router (general). */
  readonly routerHint: string;
  /** הכלים שמומחה זה רשאי לבקש. מצמצם את בלוק ה-TOOLS. [] = בלי בלוק כלים. */
  readonly tools: readonly ToolName[];
  /** אילו בלוקים תפעוליים משותפים לכלול. ברירות מחדל מטה. */
  readonly blocks?: {
    assumptions?: boolean; // ברירת מחדל true
    approval?: boolean;    // ברירת מחדל false — רק מסלולים שפונים החוצה
    confidence?: boolean;  // ברירת מחדל true
    pending?: boolean;     // ברירת מחדל true
    learning?: boolean;    // ברירת מחדל true
  };
}
```

> **הערה על החוזה האחיד:** ה-enum של `toolRequests` ב-`PLANNER_OUTPUT_SCHEMA` נשאר **גלובלי** (כל הכלים). הצמצום ב-`tools` הוא *מנחה* בתוך הפרומפט בלבד — כך מומחה עדיין *יכול* לבקש כלי חוצה אם באמת צריך, והוולידציה למטה אף פעם לא נשברת. הפרדה נקייה: ניסוח צר, חוזה אחיד.

---

## 4. הבלוקים המשותפים (`planner-shared.ts`)

מעבירים לכאן את `PLANNER_CORE` ו-`PLANNER_OUTPUT_SCHEMA` (כבר קיימים ב-`planner.prompt.ts`), ומפצלים את ה"אמצע" של הפרומפט הנוכחי לבלוקים נפרדים — **כל קטע הופך לקבוע יחיד**:

```ts
export const PLANNER_CORE = `...`;            // (קיים) זהות + סולם + אנטי-הזיה + דיסלקציה
export const ASSUMPTIONS_BLOCK = `=== ASSUMPTIONS ===\n...`;
export const APPROVAL_BLOCK   = `=== APPROVAL POLICY (graduated) ===\n...`;
export const CONFIDENCE_BLOCK = `CONFIDENCE:\n...`;
export const PENDING_BLOCK    = `ANSWERING PENDING ITEMS:\n...`;
export const LEARNING_BLOCK   = `LEARNING (memoryWrites):\n...`;
export const PLANNER_OUTPUT_SCHEMA = `OUTPUT: ...`; // (קיים)
```

התוכן של כל בלוק = הטקסט המדויק מהפרומפט הנוכחי (גזירה ולא כתיבה מחדש), כדי שעוגן הרגרסיה (`general`) יישאר byte-identical.

### 4.1 שינוי ב-`tool-registry.ts` — בלוק כלים לפי תת-קבוצה

כרגע `buildToolsPromptBlock()` מחזיר את כל הכלים. מוסיפים פרמטר אופציונלי ועוטפים בכותרת/כללים המלאים, כדי שמומחה יקבל רק את הכלים שלו:

```ts
export function buildToolsPromptBlock(subset?: readonly ToolName[]): string {
  const tools = subset ? TOOLS.filter((t) => subset.includes(t.name)) : TOOLS;
  return tools.map((t) => `- ${t.name} — ${t.description}`).join('\n');
}

/** בלוק TOOLS שלם (כותרת + הסבר + רשימה מצומצמת + כללים). subset ריק → כל הכלים (התנהגות נוכחית). */
export function buildToolsSection(subset?: readonly ToolName[]): string {
  return `=== TOOLS (toolRequests) — search instead of asking ===
Emit toolRequests to resolve missing context, then you will be re-invoked with the findings appended to the prompt. Use them BEFORE asking the owner:
${buildToolsPromptBlock(subset)}
Rules: request only what you actually need; don't request a tool whose answer is already in the context or in the findings; don't re-request the same tool after it returned findings — at that point infer, assume, or ask. When you emit toolRequests, you may leave actions empty for this turn (you'll finalize them after the findings come back).`;
}
```

> הטקסט בתוך `buildToolsSection` הוא בדיוק ה-TOOLS section מהפרומפט הנוכחי — כך `general` (subset=all) נשאר זהה לבית.

---

## 5. ה-Composer והרישום (`specialists/specialist.registry.ts`)

הרכבה בסדר קנוני **זהה לסדר הנוכחי** של הפרומפט (CORE → TOOLS → ASSUMPTIONS → APPROVAL → CONFIDENCE → PENDING → LEARNING → SCHEMA). מומחה צר פשוט מדלג על בלוקים — הנותרים נשארים בסדר הקנוני:

```ts
import { buildToolsSection } from '../../orchestration/tool-registry';
import {
  PLANNER_CORE, ASSUMPTIONS_BLOCK, APPROVAL_BLOCK, CONFIDENCE_BLOCK,
  PENDING_BLOCK, LEARNING_BLOCK, PLANNER_OUTPUT_SCHEMA,
} from '../planner-shared';
import { PlannerIntent } from '../router/route.schema';
import { Specialist } from './specialist.types';

import { scheduleSpecialist } from './schedule.specialist';
import { taskSpecialist }     from './task.specialist';
import { documentSpecialist } from './document.specialist';
import { emailSpecialist }    from './email.specialist';
import { chitchatSpecialist } from './chitchat.specialist';
import { generalSpecialist }  from './general.specialist';

/** Record מלא ⇒ כוונה ללא מומחה = שגיאת קומפילציה. מקור-אמת יחיד לבחירת מומחה. */
export const SPECIALISTS: Record<PlannerIntent, Specialist> = {
  schedule: scheduleSpecialist,
  task:     taskSpecialist,
  document: documentSpecialist,
  email:    emailSpecialist,
  chitchat: chitchatSpecialist,
  general:  generalSpecialist,
};

export const SPECIALIST_LIST = Object.values(SPECIALISTS);

export function buildSpecialistSystemPrompt(s: Specialist): string {
  const b = s.blocks ?? {};
  return [
    PLANNER_CORE,
    s.tools.length ? buildToolsSection(s.tools) : '',
    b.assumptions !== false ? ASSUMPTIONS_BLOCK : '',
    b.approval === true     ? APPROVAL_BLOCK    : '',
    b.confidence !== false  ? CONFIDENCE_BLOCK  : '',
    b.pending !== false     ? PENDING_BLOCK     : '',
    b.learning !== false    ? LEARNING_BLOCK    : '',
    PLANNER_OUTPUT_SCHEMA,
  ].filter(Boolean).join('\n\n');
}

const CONFIDENCE_FLOOR = 0.6;
/** crossDomain או סיווג לא-ודאי → general (המונוליט). route חסר → general. */
export function resolveIntent(route?: RouteDecision): PlannerIntent {
  if (!route) return 'general';
  if (route.crossDomain || route.confidence < CONFIDENCE_FLOOR) return 'general';
  return route.intent;
}
```

### 5.1 דוגמאות מומחים (כל אחד ~8 שורות)

```ts
// schedule.specialist.ts — יומן: צריך כלי יומן + איתור איש קשר, ומדיניות אישור (הזמנת אורח חיצוני)
export const scheduleSpecialist: Specialist = {
  intent: 'schedule',
  routerHint: 'meetings, calendar, availability, reminders, time-blocking, moving/finding a slot',
  tools: ['calendar_freebusy', 'calendar_agenda', 'gmail_find_contact'],
  blocks: { approval: true },
};

// email.specialist.ts — מייל יוצא: כלי gmail + מדיניות אישור (שליחה החוצה תמיד טיוטה)
export const emailSpecialist: Specialist = {
  intent: 'email',
  routerHint: 'sending email/messages to people, drafting outbound, finding a contact address',
  tools: ['gmail_find_contact', 'gmail_search'],
  blocks: { approval: true },
};

// document.specialist.ts — מסמכים/דוחות: מחקר רקע + אישור (שיתוף חיצוני)
export const documentSpecialist: Specialist = {
  intent: 'document',
  routerHint: 'drafting documents/reports, official text, background research for a doc',
  tools: ['web_research', 'gmail_search'],
  blocks: { approval: true },
};

// task.specialist.ts — משימות/תעדוף: בדרך כלל פנימי, ללא בלוק אישור
export const taskSpecialist: Specialist = {
  intent: 'task',
  routerHint: 'to-dos, tasks, prioritization, breaking work down, follow-ups',
  tools: ['calendar_agenda'],
  // blocks: ברירת מחדל — assumptions/confidence/pending/learning דולקים, approval כבוי
};

// chitchat.specialist.ts — שיחה: בלי כלים, בלי הנחות/אישור; שומר זהות + answering-pending + learning
export const chitchatSpecialist: Specialist = {
  intent: 'chitchat',
  routerHint: 'casual talk, a general question, no action needed',
  tools: [],
  blocks: { assumptions: false, confidence: false, approval: false },
};

// general.specialist.ts — עוגן הרגרסיה: כל הכלים + כל הבלוקים בסדר הנוכחי ⇒ byte-identical למונוליט
import { TOOL_NAMES } from '../../orchestration/tool-registry';
export const generalSpecialist: Specialist = {
  intent: 'general',
  routerHint: '', // לא מוצע ל-router
  tools: [...TOOL_NAMES],
  blocks: { approval: true }, // השאר ברירת מחדל true ⇒ הרכבה זהה להיום
};
```

---

## 6. ה-Router (`router/`)

### 6.1 הפרומפט — נגזר מהרישום (`planner-router.prompt.ts`)

```ts
import { SPECIALIST_LIST } from '../specialists/specialist.registry';

export function buildRouterSystemPrompt(): string {
  const options = SPECIALIST_LIST
    .filter((s) => s.routerHint)               // general מסונן (אין hint)
    .map((s) => `- ${s.intent}: ${s.routerHint}`)
    .join('\n');
  return `You classify ONE incoming Hebrew WhatsApp message for a work assistant.
The owner is dyslexic and may use voice transcripts — read for INTENT, not spelling.
Pick the single best intent:
${options}

crossDomain=true ONLY if the message clearly needs TWO+ of these at once (e.g. schedule a meeting AND email someone). Set confidence honestly (how sure you are of the single intent).
Return ONLY JSON: {"intent": string, "crossDomain": boolean, "confidence": number}`;
}
```

> הוספת מומחה למעלה ⇒ ה-router לומד עליו אוטומטית. אין רשימת כוונות מקודדת-קשיח בשני מקומות.

### 6.2 השירות (`planner-router.service.ts`) — לעולם לא זורק

```ts
@Injectable()
export class PlannerRouterService {
  private readonly logger = new AppLogger('PlannerRouter');
  constructor(private readonly ai: AiService) {}

  async classify(ctx: PlannerContextInput): Promise<RouteDecision> {
    try {
      const raw = await this.ai.complete({
        system: buildRouterSystemPrompt(),
        messages: [{ role: 'user', content: buildRouterUserPrompt(ctx) }],
        jsonMode: true, temperature: 0, maxTokens: 150, tier: 'light',
      });
      return routeDecisionSchema.parse(JSON.parse(raw));
    } catch (e) {
      this.logger.warn('Router failed → general', { error: (e as Error).message });
      return { intent: 'general', crossDomain: false, confidence: 0 }; // fallback בטוח = מונוליט
    }
  }
}
```

`buildRouterUserPrompt(ctx)` — **מינימלי** לחיסכון: רק `text`/`transcript`/`mediaSummary` (+ אולי שורת ה-pending אם קיימת). בלי זיכרון/היסטוריה מלאה — הסיווג לא צריך אותם.

---

## 7. החיווט (שינויים נקודתיים)

### 7.1 `PlannerContextInput` (ב-`planner.prompt.ts`)

```ts
import { RouteDecision } from './router/route.schema';
export interface PlannerContextInput {
  // ... קיים ...
  /** הוכרע פעם אחת ע"י ה-router; נושא את עצמו דרך כל סבבי ה-resolution loop. */
  route?: RouteDecision;
}
```

### 7.2 `PlannerService.plan` — בוחר מומחה, שומר tiering

```ts
constructor(private readonly ai: AiService) {}

async plan(ctx: PlannerContextInput): Promise<PlannerOutput> {
  const specialist = SPECIALISTS[resolveIntent(ctx.route)];   // route חסר → general
  const light = await this.attempt(ctx, specialist, 'light');
  if (light && light.confidence >= 0.6) return light;
  const heavy = await this.attempt(ctx, specialist, 'heavy');
  if (heavy) return heavy;
  if (light) return light;
  return this.fallbackClarification();
}

private async attempt(ctx, specialist: Specialist, tier: 'light'|'heavy') {
  const system = buildSpecialistSystemPrompt(specialist);   // במקום הקבוע PLANNER_SYSTEM_PROMPT
  // ... שאר ה-attempt זהה ...
}
```

> `PLANNER_SYSTEM_PROMPT` יכול להישאר כ-export נגזר: `export const PLANNER_SYSTEM_PROMPT = buildSpecialistSystemPrompt(generalSpecialist);` — שומר על תאימות לאחור לכל מי שמייבא אותו.

### 7.3 ה-Processor — 2 שורות + דגל (ה-loop לא משתנה)

ב-`message-processor.service.ts`, אחרי בניית `plannerCtx` ולפני `let plan = ...`:

```ts
constructor(/* ... */ private readonly router: PlannerRouterService) {}

// ...
if (env().PLANNER_ROUTER_ENABLED) {
  plannerCtx.route = await this.router.classify(plannerCtx);   // מסווג פעם אחת
}
let plan = await this.planner.plan(plannerCtx);
```

**קריטי — caching אוטומטי:** ה-loop כבר עושה `this.planner.plan({ ...plannerCtx, toolFindings: [...] })`. מכיוון ש-`route` כבר על `plannerCtx`, הוא **נישא לכל סבב מחדש בחינם** — ה-router לא רץ שוב, והסיווג לא משתנה בין סבבים. אפס שינוי ב-loop.

### 7.4 המודול

```ts
@Module({
  providers: [PlannerService, PlannerRouterService],
  exports: [PlannerService, PlannerRouterService],
})
export class PlannerModule {}
```
(ולוודא ש-`AiService` זמין למודול — כמו ש-`PlannerService` כבר מקבל אותו.)

### 7.5 הדגל (`config/env.ts`)

⚠️ **gotcha:** `z.coerce.boolean()` מתרגם כל מחרוזת לא-ריקה ל-`true` (כולל `"false"`). להשתמש בהשוואה מפורשת:

```ts
PLANNER_ROUTER_ENABLED: z
  .string().optional().default('false')
  .transform((v) => v === 'true' || v === '1'),
```

---

## 8. אסטרטגיית אימות (בלי Node מקומי)

1. **בדיקת golden לעוגן הרגרסיה.** לפני הפיצול: לתפוס snapshot של המחרוזת המורכבת הנוכחית. אחרי: טסט שמוודא
   `buildSpecialistSystemPrompt(SPECIALISTS.general) === <snapshot>` — מבטיח שמסלול ה-fallback זהה לבית להיום.
2. **בדיקת exhaustiveness** — `Record<PlannerIntent, Specialist>` כבר נותן את זה בקומפילציה.
3. **בדיקת router קלילה** — כמה הודעות לדוגמה → לוודא שהסיווג סביר (ולפחות שלא זורק).
4. **rollout מדורג:** מפצלים → push → Railway בונה → `/status` ירוק (הכל עדיין `general`, דגל כבוי). מדליקים `PLANNER_ROUTER_ENABLED=true` → צופים בכמה הודעות חיות → מגלגלים אחורה ע"י כיבוי הדגל אם צריך.

---

## 9. סדר ביצוע (מחולק ל-PR-ים קטנים, כל אחד מתקמפל לבד)

1. **PR-1 — חילוץ בלוקים (נטו refactor, בלי התנהגות חדשה):** מעבירים את הבלוקים ל-`planner-shared.ts`, מוסיפים `buildToolsSection`, ו-`PLANNER_SYSTEM_PROMPT` נשאר זהה (מורכב מהבלוקים). verify: טסט golden ש-`PLANNER_SYSTEM_PROMPT` לא השתנה.
2. **PR-2 — חוזים + רישום + מומחים:** `route.schema.ts`, `specialist.types.ts`, ששת קבצי המומחים, `specialist.registry.ts`. verify: golden ש-`general` == snapshot; קומפילציה ירוקה.
3. **PR-3 — ה-router:** `planner-router.*`, רישום במודול. verify: טסט classify לא זורק; `/status` אחרי deploy.
4. **PR-4 — חיווט מאחורי דגל:** `route` על ה-ctx, `PlannerService.plan` בוחר מומחה, 2 שורות ב-processor, דגל ב-env (default false). verify: דגל כבוי = התנהגות זהה; deploy; ואז הדלקה מבוקרת.

---

## 10. התשואה המודולרית (מה השתנה בעבודה היומיומית)

- **לשנות התנהגות של מסלול אחד:** עורכים קובץ מומחה אחד (`schedule.specialist.ts`) — מצהירים בלוקים/כלים. שום מסלול אחר לא מושפע.
- **לשנות כלל-רוחב (אישורים/אנטי-הזיה):** עורכים בלוק יחיד ב-`planner-shared.ts` — כל המומחים מתעדכנים.
- **להוסיף מומחה חדש:** קובץ + שורה ברישום + `hint`. ה-router לומד אוטומטית; חוסר רישום = שגיאת קומפילציה.
- **להוסיף כלי:** עדיין במקום אחד (`tool-registry`), והמומחים בוחרים תת-קבוצה.

---

## 11. החלטות פתוחות / trade-offs לשים לב

- **Latency:** ה-router מוסיף קריאת-LLM להודעה. מקיל: מעקפים דטרמיניסטיים קודם (פקודות זיכרון כבר קיימות), router זול (haiku, maxTokens קטן), ו-prompt caching על `PLANNER_CORE`/הפרומפט הקבוע של ה-router. למשוך בהדק רק כשהצמצום באמת משתלם.
- **`CONFIDENCE_FLOOR` (0.6):** סף נמוך → יותר ל-general (בטוח, יקר יותר); גבוה → יותר למומחים (זול, אבל סיכון סיווג שגוי). כוונון אחרי תצפית חיה.
- **מדיניות אישורים חוצת-תחומים:** הוחלט להשאיר את **עקרון** האישור ב-`APPROVAL_BLOCK` ולהדליק אותו בכל מסלול שפונה החוצה (`schedule`/`email`/`document`), כדי שרשת הביטחון לא תיפול בטעות ממומחה. `task`/`chitchat` בלי בלוק אישור.
- **`pending` ב-chitchat:** מומלץ להשאיר דלוק — מענה לפריט ממתין יכול להגיע גם בהודעה שנשמעת קלילה.
```
