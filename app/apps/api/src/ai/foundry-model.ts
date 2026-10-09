import { ReportNarrativeError, type NarrativeModel } from '@cis/domain';

/**
 * The report narrative model: a deployment in Microsoft (Azure AI) Foundry,
 * called through the OpenAI-compatible v1 route — the route Foundry documents
 * for non-OpenAI models such as DeepSeek:
 *
 *   POST https://<resource>.services.ai.azure.com/openai/v1/chat/completions
 *   Authorization: Bearer <resource key>
 *   { "model": "<deployment name>", "messages": [...] }
 *
 * The v1 route is implicitly versioned (no api-version). AZURE_AI_ENDPOINT may
 * be the resource URL or a project URL (…/api/projects/<project>); a key
 * authenticates against the resource, so only its origin is used.
 *
 * Configuration lives in .env, never in code:
 *   AZURE_AI_ENDPOINT, AZURE_AI_API_KEY, AZURE_AI_MODEL (default DeepSeek-V4-Pro)
 */

const DEFAULT_MODEL = 'DeepSeek-V4-Pro';
const TIMEOUT_MS = 180_000;

export function foundryChatUrl(endpoint: string): string {
  return `${new URL(endpoint).origin}/openai/v1/chat/completions`;
}

export function foundryModelFromEnv(env: NodeJS.ProcessEnv = process.env): NarrativeModel {
  const endpoint = env['AZURE_AI_ENDPOINT'];
  const apiKey = env['AZURE_AI_API_KEY'];
  const name = env['AZURE_AI_MODEL'] || DEFAULT_MODEL;
  return {
    name,
    async complete(system, user) {
      if (!endpoint || !apiKey) {
        throw new ReportNarrativeError(
          'AI narrative is not configured — set AZURE_AI_ENDPOINT and AZURE_AI_API_KEY in .env.',
          'AI_NOT_CONFIGURED',
        );
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(foundryChatUrl(endpoint), {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: name,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: 0.2,
            max_tokens: 4096,
          }),
        });
      } catch (err) {
        throw new ReportNarrativeError(
          controller.signal.aborted
            ? 'The AI model did not answer in time. Try again.'
            : `Could not reach the AI model (${(err as Error).message}).`,
          'AI_UNAVAILABLE',
        );
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        // The body can carry Azure's reason; the key is never in it.
        const detail = (await res.text()).slice(0, 300);
        throw new ReportNarrativeError(
          `The AI model refused the request (HTTP ${res.status}): ${detail}`,
          'AI_UNAVAILABLE',
        );
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new ReportNarrativeError('The AI model returned an empty answer.', 'AI_UNAVAILABLE');
      }
      return content;
    },
  };
}
