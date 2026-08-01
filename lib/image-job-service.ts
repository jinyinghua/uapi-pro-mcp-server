import { buildImageJobFileUrl, getPublicBaseUrl } from '@/lib/app-url';
import { handleImageViaConversation } from '@/lib/chatgpt-image';
import { generateImageWithOpenAiProviders } from '@/lib/openai-image-provider';
import {
  acquireJobLock,
  buildImageRequestFingerprint,
  createOrReuseJob,
  getJobById,
  ImageJobAsset,
  ImageJobRecord,
  patchJob,
  releaseJobLock,
} from '@/lib/image-job-store';

function dataUriToAsset(url: string, revisedPrompt?: string): ImageJobAsset {
  if (!url.startsWith('data:')) {
    return { originUrl: url, revisedPrompt };
  }
  const commaIndex = url.indexOf(',');
  if (commaIndex < 0) {
    return { originUrl: url, revisedPrompt };
  }
  const header = url.slice(5, commaIndex);
  const body = url.slice(commaIndex + 1);
  const mimeType = header.split(';', 1)[0] || 'image/png';
  return {
    mimeType,
    b64Json: body,
    revisedPrompt,
  };
}

export async function ensureImageJobStarted(job: ImageJobRecord) {
  if (job.status === 'succeeded' || job.status === 'failed') return job;
  const lockToken = await acquireJobLock(job.id);
  if (!lockToken) return getJobById(job.id);

  try {
    const latest = await patchJob(job.id, { status: 'running', error: undefined });
    const active = latest || job;
    const imageRequest = {
      prompt: active.request.prompt,
      model: active.request.model,
      n: active.request.n || 1,
      size: active.request.size || 'auto',
      quality: active.request.quality || 'auto',
      background: active.request.background || 'auto',
      responseFormat: active.request.responseFormat || 'url',
      inputImages: active.request.inputImages,
    };

    // A configured OpenAI-compatible provider pool owns the matching model. When
    // no pool provider matches, retain the existing ChatGPT conversation backend.
    const providerResult = await generateImageWithOpenAiProviders(imageRequest, active.id);
    const result = providerResult
      ? {
          created: Math.floor(Date.now() / 1000),
          data: providerResult.data,
          text: providerResult.text,
        }
      : await handleImageViaConversation({
          ...imageRequest,
          persistPrefix: `image-jobs/${active.id}`,
        });

    const assets: ImageJobAsset[] = result.data.map((item) => {
      if (item.url?.startsWith('data:')) return dataUriToAsset(item.url, item.revised_prompt);
      if (item.b64_json) return { b64Json: item.b64_json, revisedPrompt: item.revised_prompt };
      return { originUrl: item.url, b64Json: item.b64_json, revisedPrompt: item.revised_prompt };
    });

    await patchJob(active.id, {
      status: 'succeeded',
      result: {
        assets,
        text: result.text || '',
      },
      error: undefined,
    });
  } catch (error) {
    await patchJob(job.id, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await releaseJobLock(job.id, lockToken);
  }

  return getJobById(job.id);
}

export async function createOrGetImageJob(params: {
  ownerToken: string;
  model: string;
  prompt: string;
  size?: string;
  quality?: string;
  background?: string;
  responseFormat?: string;
  n?: number;
  inputImages?: Array<{ url: string }>;
}) {
  const fingerprint = buildImageRequestFingerprint({
    model: params.model,
    prompt: params.prompt,
    size: params.size,
    quality: params.quality,
    background: params.background,
    responseFormat: params.responseFormat,
    n: params.n,
    inputImages: params.inputImages,
  });

  return createOrReuseJob({
    fingerprint,
    ownerTokenHash: params.ownerToken,
    request: {
      model: params.model,
      prompt: params.prompt,
      size: params.size,
      quality: params.quality,
      background: params.background,
      responseFormat: params.responseFormat,
      n: params.n,
      inputImages: params.inputImages,
    },
  });
}

export async function waitForImageJob(jobId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getJobById(jobId);
    if (!job) return null;
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return getJobById(jobId);
}

export function buildOpenAiImageGenerationResponse(job: ImageJobRecord, baseUrl: string, responseFormat = 'url') {
  const assets = job.result?.assets || [];
  return {
    created: Math.floor(job.updatedAt / 1000),
    data: assets.map((asset, index) => {
      const proxyUrl = buildImageJobFileUrl(baseUrl, job.id, index);
      if (responseFormat === 'b64_json' && asset.b64Json) {
        return {
          url: proxyUrl,
          b64_json: asset.b64Json,
          revised_prompt: asset.revisedPrompt || '',
        };
      }
      return {
        url: proxyUrl,
        revised_prompt: asset.revisedPrompt || '',
      };
    }),
  };
}

export function buildChatCompletionImageResponse(job: ImageJobRecord, model: string, baseUrl: string) {
  const assets = job.result?.assets || [];
  const urls = assets.map((_, index) => buildImageJobFileUrl(baseUrl, job.id, index));
  const markdown = urls.map((url) => `![image](${url})`).join('\n\n');
  const text = [job.result?.text || '', markdown].filter(Boolean).join('\n\n') || 'Image generation completed.';
  return {
    id: `chatcmpl-${crypto.randomUUID().slice(0, 12)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text,
          images: urls.map((url, index) => ({ url, revised_prompt: assets[index]?.revisedPrompt || '' })),
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export function buildImageTimeoutResponse(job: ImageJobRecord, request?: Request) {
  const baseUrl = getPublicBaseUrl(request);
  return Response.json(
    {
      error: {
        message: 'Image generation is still running. Please retry this same request later.',
        type: 'image_generation_in_progress',
        code: 'image_job_timeout',
        job_id: job.id,
        status_url: `${baseUrl}/v1/images/jobs/${job.id}`,
      },
    },
    {
      status: 503,
      headers: {
        'Retry-After': '10',
        'X-Image-Job-Id': job.id,
      },
    },
  );
}
