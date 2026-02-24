// @ts-nocheck

import { normalizeSingleSize, normalizeSizeList } from '@/lib/cj/size-normalization';

describe('normalizeSingleSize', () => {
  it('normalizes noisy prefixed values into canonical alpha sizes', () => {
    expect(normalizeSingleSize('Milk Tea Color-S', { allowNumeric: false })).toBe('S');
    expect(normalizeSingleSize('Milky-XL', { allowNumeric: false })).toBe('XL');
    expect(normalizeSingleSize('WQZIP01SX6830-2XL', { allowNumeric: false })).toBe('2XL');
  });

  it('maps aliases and strips unsupported numeric values when numeric sizes are disabled', () => {
    expect(normalizeSingleSize('Free Size', { allowNumeric: false })).toBe('ONE SIZE');
    expect(normalizeSingleSize('42', { allowNumeric: false })).toBeNull();
  });
});

describe('normalizeSizeList', () => {
  it('deduplicates, canonicalizes, and sorts mixed size tokens', () => {
    const sizes = normalizeSizeList(
      [
        'milk tea color-s',
        'S',
        'large',
        'Milky-XL',
        'WQZIP01SX6830-2XL',
        'xxl',
        'free size',
        'ONE SIZE',
      ],
      { allowNumeric: false }
    );

    expect(sizes).toEqual(['S', 'L', 'XL', '2XL', 'ONE SIZE']);
  });
});
