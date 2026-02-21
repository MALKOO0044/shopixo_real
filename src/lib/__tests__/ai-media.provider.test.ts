// @ts-nocheck

const mockFetchWithMeta = jest.fn();

jest.mock('@/lib/http', () => ({
  fetchWithMeta: (...args: any[]) => mockFetchWithMeta(...args),
}));

import {
  AI_MEDIA_PROVIDER_REQUIRED_MESSAGE,
  generateAIMediaAsset,
  isAIMediaProviderConfigured,
} from '@/lib/ai/media/provider';

const baseInput = {
  mediaType: 'image' as const,
  cjProductId: '123456',
  color: 'Navy Blue',
  mediaIndex: 1,
  anchorImageUrl: 'https://example.com/anchor.jpg',
  outputWidth: 2048,
  outputHeight: 2048,
  categoryPrompt: 'Luxury product shoot',
  categoryNegativePrompt: 'blurry, low quality',
  preferredVisualStyle: 'editorial ecommerce',
  luxuryPresentation: true,
};

describe('AI media provider integration', () => {
  const prevProviderUrl = process.env.AI_MEDIA_PROVIDER_URL;
  const prevProviderToken = process.env.AI_MEDIA_PROVIDER_TOKEN;
  const prevProviderTimeout = process.env.AI_MEDIA_PROVIDER_TIMEOUT_MS;
  const prevProviderRetries = process.env.AI_MEDIA_PROVIDER_RETRIES;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AI_MEDIA_PROVIDER_URL = 'https://provider.example.com/generate';
    process.env.AI_MEDIA_PROVIDER_TOKEN = 'provider-token';
    delete process.env.AI_MEDIA_PROVIDER_TIMEOUT_MS;
    delete process.env.AI_MEDIA_PROVIDER_RETRIES;
  });

  afterAll(() => {
    process.env.AI_MEDIA_PROVIDER_URL = prevProviderUrl;
    process.env.AI_MEDIA_PROVIDER_TOKEN = prevProviderToken;
    process.env.AI_MEDIA_PROVIDER_TIMEOUT_MS = prevProviderTimeout;
    process.env.AI_MEDIA_PROVIDER_RETRIES = prevProviderRetries;
  });

  it('throws when provider URL is missing', async () => {
    delete process.env.AI_MEDIA_PROVIDER_URL;

    expect(isAIMediaProviderConfigured()).toBe(false);
    await expect(generateAIMediaAsset(baseInput)).rejects.toThrow(AI_MEDIA_PROVIDER_REQUIRED_MESSAGE);
    expect(mockFetchWithMeta).not.toHaveBeenCalled();
  });

  it('throws provider request errors instead of returning fallback source media', async () => {
    mockFetchWithMeta.mockResolvedValue({
      ok: false,
      status: 503,
      body: { error: 'provider unavailable' },
    });

    await expect(generateAIMediaAsset(baseInput)).rejects.toThrow(
      'AI media provider request failed: provider unavailable'
    );
  });

  it('returns external provider output when provider succeeds', async () => {
    mockFetchWithMeta.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        outputUrl: 'https://cdn.example.com/generated/output.mp4',
        provider: 'external_provider',
        assetId: 'asset_123',
        meta: { traceId: 'trace-1' },
      },
    });

    const result = await generateAIMediaAsset({
      ...baseInput,
      mediaType: 'video',
      sourceVideoUrl: 'https://example.com/reference.mp4',
    });

    expect(result.url).toBe('https://cdn.example.com/generated/output.mp4');
    expect(result.provider).toBe('external_provider');
    expect(result.providerAssetId).toBe('asset_123');
    expect(result.promptSnapshot).toEqual(
      expect.objectContaining({
        providerPayload: expect.objectContaining({ mediaType: 'video' }),
      })
    );
  });

  it('applies provider timeout/retry env configuration to remote microservice calls', async () => {
    process.env.AI_MEDIA_PROVIDER_TIMEOUT_MS = '45000';
    process.env.AI_MEDIA_PROVIDER_RETRIES = '2';

    mockFetchWithMeta.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        outputUrl: 'https://cdn.example.com/generated/output.jpg',
      },
    });

    const result = await generateAIMediaAsset(baseInput);

    expect(result.provider).toBe('internal_microservice');
    expect(result.promptSnapshot).toEqual(
      expect.objectContaining({
        providerRequestOptions: {
          timeoutMs: 45000,
          retries: 2,
        },
      })
    );

    expect(mockFetchWithMeta).toHaveBeenCalledWith(
      'https://provider.example.com/generate',
      expect.objectContaining({ timeoutMs: 45000, retries: 2 })
    );
  });
});
