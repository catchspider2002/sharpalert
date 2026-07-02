// DeepInfra - OpenAI-compatible chat completions (https://api.deepinfra.com/v1/openai).
export const DEEPINFRA_MODEL = 'deepseek-ai/DeepSeek-V3.2';

const URL = 'https://api.deepinfra.com/v1/openai/chat/completions';

export async function chat(
  apiKey: string,
  opts: { system: string; user: string; maxTokens: number; model?: string },
): Promise<string | null> {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: opts.model || DEEPINFRA_MODEL,
      max_tokens: opts.maxTokens,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
    }),
  });
  if (!res.ok) return null;
  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content?.trim() || null;
}
