// @ts-nocheck

import {
  extractCjProductGalleryImages,
  normalizeCjImageKey,
  prioritizeCjHeroImage,
} from '@/lib/cj/image-gallery';

describe('normalizeCjImageKey', () => {
  it('normalizes query/hash and strips size suffixes for dedupe', () => {
    const key = normalizeCjImageKey('https://cdn.example.com/images/item_1200x1200.jpg?x=1#foo');
    expect(key).toBe('https://cdn.example.com/images/item.jpg');
  });
});

describe('prioritizeCjHeroImage', () => {
  it('moves highest quality image to the first position and keeps order of others stable', () => {
    const input = [
      'https://cdn.example.com/images/item_600x600.jpg',
      'https://cdn.example.com/original/item_master.jpg',
      'https://cdn.example.com/images/item_800x800.jpg',
    ];

    const output = prioritizeCjHeroImage(input);

    expect(output[0]).toContain('/original/');
    expect(output.slice(1)).toEqual([
      'https://cdn.example.com/images/item_600x600.jpg',
      'https://cdn.example.com/images/item_800x800.jpg',
    ]);
  });
});

describe('extractCjProductGalleryImages', () => {
  it('extracts from productImageSet JSON, variant/property fields, filters noisy assets, and dedupes', () => {
    const item = {
      productImageSet: JSON.stringify([
        'https://cdn.example.com/images/main_200x200.jpg?cache=1',
        'https://cdn.example.com/images/main_1200x1200.jpg?cache=2',
      ]),
      bigImage: 'https://cdn.example.com/original/hero_master.jpg?foo=bar',
      imageList: [
        'https://cdn.example.com/images/main_1200x1200.jpg?cache=3',
        'https://cdn.example.com/assets/badge-sale.png',
        { imageUrl: 'https://cdn.example.com/images/alt_900x900.jpg' },
      ],
      productPropertyList: [
        {
          propertyNameEn: 'Color',
          propertyValueList: [
            {
              propertyValueNameEn: 'Black',
              image: 'https://cdn.example.com/images/color_black_1000x1000.jpg?w=1200',
            },
          ],
        },
      ],
      variantList: [
        {
          variantImage: 'https://cdn.example.com/images/variant_800x800.jpg',
          whiteImage: 'https://cdn.example.com/images/variant_white_120x120.jpg',
        },
      ],
    };

    const images = extractCjProductGalleryImages(item, 50);

    expect(images.length).toBeGreaterThan(0);
    expect(images[0]).toContain('/original/');
    expect(images.some((url) => url.includes('main_200x200'))).toBe(false);
    expect(images.some((url) => url.includes('badge-sale'))).toBe(false);
    expect(images.some((url) => url.includes('variant_white_120x120'))).toBe(false);

    const normalizedKeys = images.map((url) => normalizeCjImageKey(url));
    expect(new Set(normalizedKeys).size).toBe(images.length);
  });

  it('keeps a non-empty gallery by fallback pass when all candidates look small', () => {
    const item = {
      imageList: [
        'https://cdn.example.com/images/product_200x200.jpg',
        'https://cdn.example.com/images/product_240x240.jpg',
      ],
    };

    const images = extractCjProductGalleryImages(item, 10);

    expect(images.length).toBeGreaterThan(0);
    expect(images.every((url) => /^https?:\/\//i.test(url))).toBe(true);
  });
});
