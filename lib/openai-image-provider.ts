import crypto from 'node:crypto';

export type OpenAiImageRequest = {
  prompt: string;
  model: string;
  n: number;
  size: string;
  quality: string;
  background: string;
  responseFormat: string;
  inputImages?: Array<{ url: string }>;
};

export type OpenAiCompatibleImage = {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
};

export type OpenAiCompatibleImageResult = {
  providerId: string;
  data: OpenAiCompatibleImage[];
  text?: string;
};

type ProviderConfig = {
  id: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  modelMap: Record<string, string>;
  headers: Record<string, string>;
  timeoutMs: number;
};

type RawProviderConfig = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 120_000;

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map(stringValue).filter(Boolean).map((item) => item.toLowerCase());
}

function stringMap(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => typeof item === 'string' && item.trim())
      .map(([key, item]) => [key.toLowerCase(), (item as string).trim()]),
  );
}

function headersMap(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => key && typeof item === 'string' && item.trim())
      .map(([key, item]) => [key, (item as string).trim()]),
  );
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, '').replace(/\/images\/generations$/, '');
}

function parseProvider(raw: RawProviderConfig, index: number): ProviderConfig | null {
  if (raw.enabled === false) return null;
  const baseUrl = normalizeBaseUrl(stringValue(raw.baseUrl) || stringValue(raw.base_url));
  const apiKeyEnv = stringValue(raw.apiKeyEnv) || stringValue(raw.api_key_env);
  const apiKey = stringValue(raw.apiKey) || stringValue(raw.api_key) || (apiKeyEnv ? stringValue(process.env[apiKeyEnv]) : '');
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return null;

  return {
    id: stringValue(raw.id) || `openai-provider-${index + 1}`,
    baseUrl,
    apiKey,
    models: stringList(raw.models),
    modelMap: stringMap(raw.modelMap || raw.model_map),
    headers: headersMap(raw.headers),
    timeoutMs: Math.max(1_000, Math.min(Number(raw.timeoutMs || raw.timeout_ms) || DEFAULT_TIMEOUT_MS, 300_000)),
  };
}

/**
 * Reads a JSON provider pool from OPENAI_IMAGE_PROVIDERS. A single-provider
 * shorthand is also accepted so an existing deployment only needs three vars.
 */
function getOpenAiImageProviders(): ProviderConfig[] {
  const raw = stringValue(process.env.OPENAI_IMAGE_PROVIDERS);
  let records: RawProviderConfig[] = [];
  if (raw) {
    try {
      const decoded = JSON.parse(raw) as unknown;
      records = Array.isArray(decoded) ? decoded.filter((item): item is RawProviderConfig => !!item && typeof item === 'object' && !Array.isArray(item)) : [];
    } catch {
      console.warn('[openai-image-provider] OPENAI_IMAGE_PROVIDERS is not valid JSON');
    }
  }

  if (!records.length && stringValue(process.env.OPENAI_IMAGE_BASE_URL)) {
    records = [{
      id: process.env.OPENAI_IMAGE_PROVIDER_ID || 'openai-compatible',
      baseUrl: process.env.OPENAI_IMAGE_BASE_URL,
      apiKey: process.env.OPENAI_IMAGE_API_KEY,
      models: stringValue(process.env.OPENAI_IMAGE_MODELS).split(',').map((item) => item.trim()).filter(Boolean),
    }];
  }

  return records.map(parseProvider).filter((item): item is ProviderConfig => !!item);
}

/** Returns explicitly configured client-facing image model IDs for `/v1/models`. */
export function getConfiguredOpenAiImageModelIds() {
  return [...new Set(getOpenAiImageProviders().flatMap((provider) => [...provider.models, ...Object.keys(provider.modelMap)]))];
}

function supportsModel(provider: ProviderConfig, model: string) {
  return provider.models.length === 0 || provider.models.includes(model.toLowerCase()) || Object.hasOwn(provider.modelMap, model.toLowerCase());
}

function poolStartIndex(key: string, size: number) {
  if (size <= 1) return 0;
  const value = crypto.createHash('sha256').update(key).digest().readUInt32BE(0);
  return value % size;
}

function providerErrorMessage(body: unknown, status: number) {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const error = record.error;
    if (typeof error === 'string') return error.slice(0, 500);
    if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
      return ((error as Record<string, unknown>).message as string).slice(0, 500);
    }
    if (typeof record.detail === 'string') return record.detail.slice(0, 500);
  }
  return `upstream returned HTTP ${status}`;
}

/**
 * Calls compatible `/v1/images/generations` APIs. Candidates are deterministically
 * load-balanced by job key, then tried in turn on errors, so several providers form
 * one resilient image-generation pool. Returns null when no provider owns the model.
 */
export async function generateImageWithOpenAiProviders(request: OpenAiImageRequest, jobKey: string): Promise<OpenAiCompatibleImageResult | null> {
  const candidates = getOpenAiImageProviders().filter((provider) => supportsModel(provider, request.model));
  if (!candidates.length) return null;

  const start = poolStartIndex(jobKey, candidates.length);
  const failures: string[] = [];
  for (let offset = 0; offset < candidates.length; offset += 1) {
    const provider = candidates[(start + offset) % candidates.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), provider.timeoutMs);
    const remoteModel = provider.modelMap[request.model.toLowerCase()] || request.model;
    const body: Record<string, unknown> = {
      model: remoteModel,
      prompt: request.prompt,
      n: request.n,
      size: request.size,
      quality: request.quality,
      background: request.background,
      response_format: request.responseFormat,
    };
    // Some compatible gateways support this extension for image editing; omitting it
    // when absent keeps the request valid for the official OpenAI images endpoint.
    if (request.inputImages?.length) body.input_images = request.inputImages;

    try {
      const response = await fetch(`${provider.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
          ...provider.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        failures.push(`${provider.id}: ${providerErrorMessage(payload, response.status)}`);
        continue;
      }
      const data = payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).data)
        ? (payload as Record<string, unknown>).data as unknown[]
        : [];
      const images = data.flatMap((item): OpenAiCompatibleImage[] => {
        if (!item || typeof item !== 'object') return [];
        const image = item as Record<string, unknown>;
        const url = stringValue(image.url);
        const b64Json = stringValue(image.b64_json);
        if (!url && !b64Json) return [];
        return [{ url: url || undefined, b64_json: b64Json || undefined, revised_prompt: stringValue(image.revised_prompt) || undefined }];
      });
      if (!images.length) {
        failures.push(`${provider.id}: response contains no image data`);
        continue;
      }
      console.log(`[openai-image-provider] job=${jobKey} provider=${provider.id} images=${images.length}`);
      return { providerId: provider.id, data: images, text: stringValue((payload as Record<string, unknown>).text) || undefined };
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError' ? `timed out after ${provider.timeoutMs}ms` : error instanceof Error ? error.message : String(error);
      failures.push(`${provider.id}: ${message.slice(0, 500)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`All OpenAI-compatible image providers failed (${failures.join('; ')})`);
}
