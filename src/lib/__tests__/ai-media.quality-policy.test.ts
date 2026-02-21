// @ts-nocheck

import { buildQualityContract } from '@/lib/ai/media/quality-policy';

describe('AI media quality profile defaults', () => {
  const prevQualityProfile = process.env.AI_MEDIA_QUALITY_PROFILE;
  const prevMaxImages = process.env.AI_MEDIA_MAX_IMAGES_PER_COLOR;
  const prevIncludeVideoDefault = process.env.AI_MEDIA_ENABLE_VIDEO_DEFAULT;

  afterEach(() => {
    if (typeof prevQualityProfile === 'undefined') {
      delete process.env.AI_MEDIA_QUALITY_PROFILE;
    } else {
      process.env.AI_MEDIA_QUALITY_PROFILE = prevQualityProfile;
    }

    if (typeof prevMaxImages === 'undefined') {
      delete process.env.AI_MEDIA_MAX_IMAGES_PER_COLOR;
    } else {
      process.env.AI_MEDIA_MAX_IMAGES_PER_COLOR = prevMaxImages;
    }

    if (typeof prevIncludeVideoDefault === 'undefined') {
      delete process.env.AI_MEDIA_ENABLE_VIDEO_DEFAULT;
    } else {
      process.env.AI_MEDIA_ENABLE_VIDEO_DEFAULT = prevIncludeVideoDefault;
    }
  });

  it('uses balanced defaults when no profile is configured', () => {
    delete process.env.AI_MEDIA_QUALITY_PROFILE;

    const quality = buildQualityContract({} as any);

    expect(quality.imagesPerColor).toBe(4);
    expect(quality.includeVideo).toBe(true);
    expect(quality.resolutionPreset).toBe('2k');
    expect(quality.outputWidth).toBe(2048);
    expect(quality.outputHeight).toBe(2048);
  });

  it('uses fast profile defaults when configured', () => {
    process.env.AI_MEDIA_QUALITY_PROFILE = 'fast';

    const quality = buildQualityContract({} as any);

    expect(quality.imagesPerColor).toBe(2);
    expect(quality.includeVideo).toBe(false);
    expect(quality.resolutionPreset).toBe('2k');
  });

  it('uses premium profile defaults when configured', () => {
    process.env.AI_MEDIA_QUALITY_PROFILE = 'premium';

    const quality = buildQualityContract({} as any);

    expect(quality.imagesPerColor).toBe(6);
    expect(quality.includeVideo).toBe(true);
    expect(quality.resolutionPreset).toBe('4k');
    expect(quality.outputWidth).toBe(4096);
    expect(quality.outputHeight).toBe(4096);
  });

  it('keeps explicit request values over profile defaults', () => {
    process.env.AI_MEDIA_QUALITY_PROFILE = 'fast';

    const quality = buildQualityContract({
      imagesPerColor: 7,
      includeVideo: true,
      resolutionPreset: '4k',
    } as any);

    expect(quality.imagesPerColor).toBe(7);
    expect(quality.includeVideo).toBe(true);
    expect(quality.resolutionPreset).toBe('4k');
  });

  it('falls back to balanced defaults for invalid profile values', () => {
    process.env.AI_MEDIA_QUALITY_PROFILE = 'unknown';

    const quality = buildQualityContract({} as any);

    expect(quality.imagesPerColor).toBe(4);
    expect(quality.includeVideo).toBe(true);
    expect(quality.resolutionPreset).toBe('2k');
  });

  it('caps default and explicit imagesPerColor by AI_MEDIA_MAX_IMAGES_PER_COLOR', () => {
    process.env.AI_MEDIA_QUALITY_PROFILE = 'premium';
    process.env.AI_MEDIA_MAX_IMAGES_PER_COLOR = '3';

    const defaultQuality = buildQualityContract({} as any);
    const explicitQuality = buildQualityContract({ imagesPerColor: 7 } as any);

    expect(defaultQuality.imagesPerColor).toBe(3);
    expect(explicitQuality.imagesPerColor).toBe(3);
  });

  it('uses AI_MEDIA_ENABLE_VIDEO_DEFAULT when includeVideo is omitted', () => {
    process.env.AI_MEDIA_QUALITY_PROFILE = 'balanced';
    process.env.AI_MEDIA_ENABLE_VIDEO_DEFAULT = 'false';

    const quality = buildQualityContract({} as any);

    expect(quality.includeVideo).toBe(false);
  });
});
