// Converts our neutral conversation + tool defs into OpenAI Chat Completions
// shapes, so the worker can talk to any OpenAI-compatible endpoint.
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ChatMessage } from './types';

export interface OpenAITool {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

/** Our X tool defs ({name, description, input_schema}) → OpenAI function tools. */
export function toOpenAITools(
  defs: { name: string; description: string; input_schema: unknown }[],
): OpenAITool[] {
  return defs.map((d) => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.input_schema },
  }));
}

/** Build the OpenAI `messages` array from a system prompt + our neutral messages. */
export function toOpenAIMessages(systemText: string, messages: ChatMessage[]): any[] {
  const out: any[] = [{ role: 'system', content: systemText }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    // Multimodal: map text + image blocks (others are dropped — they only exist
    // transiently inside a provider's own loop, never in the panel's history).
    const parts = m.content
      .map((b) => {
        if (b.type === 'text') return { type: 'text', text: (b as any).text };
        if (b.type === 'image') {
          const s = (b as any).source ?? {};
          return {
            type: 'image_url',
            image_url: { url: `data:${s.media_type};base64,${s.data}` },
          };
        }
        return null;
      })
      .filter(Boolean);
    out.push({ role: m.role, content: parts });
  }
  return out;
}
