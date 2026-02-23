// @ts-nocheck

import {
  extractCjProductVideoCandidates,
  extractCjProductVideoUrl,
  inferCjVideoQualityHint,
  isLikelyCjVideoUrl,
  normalizeCjVideoUrl,
} from '@/lib/cj/video';

describe('normalizeCjVideoUrl', () => {
  it('normalizes protocol-relative/http URLs to https and strips hash', () => {
    expect(normalizeCjVideoUrl('//cdn.example.com/media/video_1080p.mp4?x=1#hash')).toBe(
      'https://cdn.example.com/media/video_1080p.mp4?x=1'
    );

    expect(normalizeCjVideoUrl('http://cdn.example.com/media/video.mp4#part')).toBe(
      'https://cdn.example.com/media/video.mp4'
    );
  });

  it('returns null for invalid/non-http urls', () => {
    expect(normalizeCjVideoUrl('not-a-url')).toBeNull();
    expect(normalizeCjVideoUrl('ftp://cdn.example.com/video.mp4')).toBeNull();
  });
});

describe('isLikelyCjVideoUrl', () => {
  it('accepts known video urls and rejects non-video urls', () => {
    expect(isLikelyCjVideoUrl('https://cdn.example.com/video/item_1080p.mp4')).toBe(true);
    expect(isLikelyCjVideoUrl('https://media.example.com/videos/stream/item?id=1')).toBe(true);
    expect(isLikelyCjVideoUrl('https://cdn.example.com/images/item.jpg')).toBe(false);
  });
});

describe('inferCjVideoQualityHint', () => {
  it('infers 4k/hd/sd quality hints from url tokens', () => {
    expect(inferCjVideoQualityHint('https://cdn.example.com/v/item_4k.mp4')).toBe('4k');
    expect(inferCjVideoQualityHint('https://cdn.example.com/v/item_1080p.mp4')).toBe('hd');
    expect(inferCjVideoQualityHint('https://cdn.example.com/v/item_480p.mp4')).toBe('sd');
    expect(inferCjVideoQualityHint('https://cdn.example.com/v/item.mp4')).toBe('unknown');
  });
});

describe('extractCjProductVideoCandidates', () => {
  it('extracts, normalizes, dedupes and ranks candidates by quality', () => {
    const item = {
      videoUrl: 'https://cdn.example.com/video/sample_480p.mp4?ref=a',
      videoList: [
        'https://cdn.example.com/video/product_1080p.mp4',
        { url: 'https://cdn.example.com/video/product_4k.mp4?cache=1' },
      ],
      media: {
        primary: { mediaUrl: 'https://cdn.example.com/video/product_4k.mp4?cache=2#dup' },
      },
    };

    const videos = extractCjProductVideoCandidates(item, 10);

    expect(videos.length).toBeGreaterThanOrEqual(3);
    expect(videos[0]).toContain('product_4k.mp4');
    expect(videos[1]).toContain('product_1080p.mp4');
    expect(videos[videos.length - 1]).toContain('sample_480p.mp4');

    const comparable = videos.map((url) => {
      const u = new URL(url);
      return `${u.origin}${u.pathname}`;
    });
    expect(new Set(comparable).size).toBe(videos.length);
  });

  it('returns top-ranked candidate via extractCjProductVideoUrl', () => {
    const item = {
      videos: [
        { playUrl: 'https://cdn.example.com/video/demo_720p.mp4' },
        { playUrl: 'https://cdn.example.com/video/demo_4k.mp4' },
      ],
    };

    expect(extractCjProductVideoUrl(item)).toContain('demo_4k.mp4');
  });
});
