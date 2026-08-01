import { getConfiguredOpenAiImageModelIds } from '@/lib/openai-image-provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const defaults = [
    { id: 'gpt-image-2', object: 'model', owned_by: 'chatgpt' },
    { id: 'gpt-image-1', object: 'model', owned_by: 'chatgpt' },
    { id: 'gpt-4o', object: 'model', owned_by: 'chatgpt' },
    { id: 'gpt-5.4-mini', object: 'model', owned_by: 'chatgpt' },
    { id: 'gpt-5.5', object: 'model', owned_by: 'chatgpt' },
    { id: 'auto', object: 'model', owned_by: 'chatgpt' },
  ];
  const existing = new Set(defaults.map((model) => model.id));
  const providerModels = getConfiguredOpenAiImageModelIds()
    .filter((id) => !existing.has(id))
    .map((id) => ({ id, object: 'model', owned_by: 'openai-compatible-provider' }));

  return Response.json({
    object: 'list',
    data: [...defaults, ...providerModels],
  });
}
