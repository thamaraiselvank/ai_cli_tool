import { z } from 'zod';
import { HOOK_EVENTS } from '../hooks/index.js';
import { parseRule } from '../permissions/index.js';

/**
 * Validation for settings written by `jarvis ui`. The TUI commands build settings themselves, but
 * the web page sends whole objects, so we check them before they hit disk: a typo in a hook or an
 * allow rule should be an error on the page, not a broken Jarvis on the next start.
 *
 * Unknown keys are kept (`looseObject`): a newer Jarvis may have settings this version doesn't
 * know, and saving from the page must not delete them.
 */

const rule = z.string().refine(
  (r) => {
    try {
      parseRule(r);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'not a valid rule (use Tool, Tool(exact) or Tool(prefix:*))' },
);

const modelRef = z.string().regex(/^[^/\s]+\/\S+$/, 'use provider/model, e.g. groq/openai/gpt-oss-120b');
const fraction = z.number().gt(0).lte(1);
const positive = z.number().int().positive();

const hook = z.looseObject({
  matcher: z.string().optional(),
  command: z.string().min(1, 'a hook needs a command'),
  timeout: z.number().positive().optional(),
});

const mcpServer = z
  .looseObject({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().url().optional(),
    type: z.enum(['stdio', 'http', 'sse']).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    disabled: z.boolean().optional(),
    timeout: z.number().positive().optional(),
  })
  .refine((s) => Boolean(s.command) !== Boolean(s.url), { message: 'give either "command" (local) or "url" (remote)' });

export const settingsSchema = z.looseObject({
  model: modelRef.optional(),
  fallbacks: z.array(modelRef).optional(),
  providers: z
    .record(
      z.string(),
      z.looseObject({
        baseURL: z.string().url().optional(),
        apiKeyEnv: z.string().optional(),
        rpm: positive.optional(),
        tpm: positive.optional(),
      }),
    )
    .optional(),
  retry: z.looseObject({ maxRetries: z.number().int().min(0).optional(), maxWaitSeconds: positive.optional() }).optional(),
  tools: z
    .looseObject({
      disabled: z.array(z.string()).optional(),
      descriptions: z.record(z.string(), z.string().min(1)).optional(),
    })
    .optional(),
  permissions: z.looseObject({ allow: z.array(rule).optional(), deny: z.array(rule).optional() }).optional(),
  agents: z.looseObject({ model: modelRef.optional(), maxSteps: positive.optional() }).optional(),
  context: z
    .looseObject({
      maxToolOutputLines: positive.optional(),
      maxToolOutputBytes: positive.optional(),
      clearToolOutputAt: fraction.optional(),
      compactAt: fraction.optional(),
      keepToolResults: z.number().int().min(0).optional(),
      windows: z.record(z.string(), positive).optional(),
      defaultWindow: positive.optional(),
    })
    .optional(),
  hooks: z.partialRecord(z.enum(HOOK_EVENTS), z.array(hook)).optional(),
  mcpServers: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/, 'server names: letters, digits, - and _'), mcpServer).optional(),
});

/** [] when valid, else readable messages like "permissions.allow.0: not a valid rule". */
export function validateSettings(data: unknown): string[] {
  const r = settingsSchema.safeParse(data);
  if (r.success) return [];
  return r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}
