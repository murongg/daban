import { readFileSync } from 'node:fs';

export const inject = ['agents', 'systemPrompt'];

interface Context {
  agents: { roots(): object[] };
  systemPrompt: {
    context(section: {
      name: string;
      order: number;
      text: (assembly: { scope?: object }) => string;
      interpolate: boolean;
      required: boolean;
    }): unknown;
  };
}

export function apply(ctx: Context) {
  const file = process.env.DABAN_TASK_CONTEXT_FILE;
  if (!file) return;
  const sections: Record<string, string> = JSON.parse(readFileSync(file, 'utf8'));
  for (const [index, [name, text]] of Object.entries(sections).entries()) {
    if (!text) continue;
    ctx.systemPrompt.context({
      name: `daban:${name}`,
      order: 300 + index,
      // Each harness owns one accepted task. Its private context must stay with the root.
      text: ({ scope }) => (scope && scope === ctx.agents.roots()[0] ? text : ''),
      interpolate: false,
      required: true,
    });
  }
}
