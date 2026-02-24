type NormalizeSizeOptions = {
  allowNumeric?: boolean;
  minNumericSize?: number;
  maxNumericSize?: number;
};

const SIZE_ALIAS_MAP: Record<string, string> = {
  XS: 'XS',
  S: 'S',
  M: 'M',
  L: 'L',
  XL: 'XL',
  XXL: '2XL',
  XXXL: '3XL',
  '2XL': '2XL',
  '3XL': '3XL',
  '4XL': '4XL',
  '5XL': '5XL',
  '6XL': '6XL',
  OS: 'ONE SIZE',
  'ONE SIZE': 'ONE SIZE',
  'FREE SIZE': 'ONE SIZE',
  FREESIZE: 'ONE SIZE',
  ONESIZE: 'ONE SIZE',
  SMALL: 'S',
  MEDIUM: 'M',
  LARGE: 'L',
};

const ORDERED_ALPHA_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'];

function parseNumericSize(
  raw: string,
  minNumericSize: number,
  maxNumericSize: number
): string | null {
  const compact = raw.toUpperCase().replace(/\s+/g, ' ').trim();

  const direct = compact.match(/^(?:EU|US|UK)?\s*(\d{2,3})(?:\s*CM)?$/i);
  if (direct && direct[1]) {
    const value = Number(direct[1]);
    if (Number.isFinite(value) && value >= minNumericSize && value <= maxNumericSize) {
      return String(value);
    }
  }

  return null;
}

function normalizeToken(
  token: string,
  options: Required<NormalizeSizeOptions>
): string | null {
  if (!token) return null;

  const cleaned = token
    .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '')
    .replace(/^[\s_-]*size[\s:_-]*/i, '')
    .trim();

  if (!cleaned) return null;

  const upper = cleaned.toUpperCase();
  const compact = upper.replace(/\s+/g, ' ').trim();
  const collapsed = upper.replace(/\s+/g, '');

  if (SIZE_ALIAS_MAP[compact]) return SIZE_ALIAS_MAP[compact];
  if (SIZE_ALIAS_MAP[collapsed]) return SIZE_ALIAS_MAP[collapsed];

  const normalizedXl = compact
    .replace(/X\s*X\s*X\s*L/g, 'XXXL')
    .replace(/X\s*X\s*L/g, 'XXL')
    .replace(/(\d)\s*X\s*L/g, '$1XL')
    .replace(/X\s*L/g, 'XL');

  if (SIZE_ALIAS_MAP[normalizedXl]) return SIZE_ALIAS_MAP[normalizedXl];

  if (options.allowNumeric) {
    return parseNumericSize(compact, options.minNumericSize, options.maxNumericSize);
  }

  return null;
}

function sizeSortRank(size: string): number {
  const alphaIndex = ORDERED_ALPHA_SIZES.indexOf(size);
  if (alphaIndex >= 0) return alphaIndex;
  if (size === 'ONE SIZE') return 100;

  const numeric = Number(size);
  if (Number.isFinite(numeric)) return 200 + numeric;

  return 999;
}

export function normalizeSingleSize(
  raw: unknown,
  options: NormalizeSizeOptions = {}
): string | null {
  const resolved: Required<NormalizeSizeOptions> = {
    allowNumeric: options.allowNumeric ?? true,
    minNumericSize: options.minNumericSize ?? 20,
    maxNumericSize: options.maxNumericSize ?? 80,
  };

  if (typeof raw !== 'string') {
    if (typeof raw === 'number' && resolved.allowNumeric) {
      const value = Number(raw);
      if (Number.isFinite(value) && value >= resolved.minNumericSize && value <= resolved.maxNumericSize) {
        return String(value);
      }
    }
    return null;
  }

  const input = raw.replace(/[\u4e00-\u9fff]/g, ' ').trim();
  if (!input) return null;

  const direct = normalizeToken(input, resolved);
  if (direct) return direct;

  const splitParts = input
    .split(/[\-|_/|,;()\[\]{}]+/g)
    .map((part) => part.trim())
    .filter(Boolean);

  for (let i = splitParts.length - 1; i >= 0; i--) {
    const normalized = normalizeToken(splitParts[i], resolved);
    if (normalized) return normalized;
  }

  const words = input
    .split(/\s+/g)
    .map((part) => part.trim())
    .filter(Boolean);

  for (let i = words.length - 1; i >= 0; i--) {
    const normalized = normalizeToken(words[i], resolved);
    if (normalized) return normalized;
  }

  if (words.length >= 2) {
    for (let i = 0; i < words.length - 1; i++) {
      const pair = `${words[i]} ${words[i + 1]}`;
      const normalized = normalizeToken(pair, resolved);
      if (normalized) return normalized;
    }
  }

  return null;
}

export function normalizeSizeList(
  values: unknown,
  options: NormalizeSizeOptions = {}
): string[] {
  const items: unknown[] = Array.isArray(values)
    ? values
    : typeof values === 'string'
      ? values.split(',').map((part) => part.trim())
      : [values];

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of items) {
    const size = normalizeSingleSize(value, options);
    if (!size || seen.has(size)) continue;
    seen.add(size);
    normalized.push(size);
  }

  return normalized.sort((a, b) => {
    const rankDiff = sizeSortRank(a) - sizeSortRank(b);
    if (rankDiff !== 0) return rankDiff;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  });
}
