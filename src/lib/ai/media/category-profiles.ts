import { CATEGORIES, labelFromSlug, slugFromLabel } from '@/lib/categories'

export interface AIMediaCategoryProfile {
  id: string
  categorySlug: string
  categoryLabel: string
  promptTemplate: string
  negativePromptTemplate: string
  allowedSceneStyles: string[]
  forbiddenModifications: string[]
}

const BASE_FORBIDDEN_MODIFICATIONS = [
  'Do not alter product shape or dimensions',
  'Do not alter logos, labels, text, print, or embroidery',
  'Do not alter stitching lines, seams, closures, straps, and hardware',
  'Do not change color tone, hue, saturation, or pattern geometry',
  'Do not add/remove product components',
]

const BASE_ALLOWED_STYLES = [
  'luxury editorial lighting',
  'premium ecommerce studio',
  'clean architectural background',
  'high-end lifestyle scene',
]

function buildProfile(slug: string, label: string, sceneFocus: string): AIMediaCategoryProfile {
  return {
    id: slug,
    categorySlug: slug,
    categoryLabel: label,
    promptTemplate: [
      `Create premium ${label} visuals with ${sceneFocus}.`,
      'Keep the product exactly identical to source references in every detail.',
      'Only improve environment, composition, model pose, and cinematic lighting.',
      'Output ultra-sharp high-resolution media suitable for luxury storefront usage.',
    ].join(' '),
    negativePromptTemplate: [
      'Any product redesign, recolor, texture shift, pattern distortion, or logo mutation.',
      'Extra accessories attached to product, missing parts, or edited silhouette.',
      'Blurred product edges, low detail fabric rendering, or stylized abstraction.',
    ].join(' '),
    allowedSceneStyles: BASE_ALLOWED_STYLES,
    forbiddenModifications: BASE_FORBIDDEN_MODIFICATIONS,
  }
}

const PROFILE_MAP: Record<string, AIMediaCategoryProfile> = {
  'womens-clothing': buildProfile('womens-clothing', "Women's Clothing", 'editorial fashion backdrops and premium natural motion'),
  'mens-clothing': buildProfile('mens-clothing', "Men's Clothing", 'tailored modern scenes and strong directional lighting'),
  'bags-shoes': buildProfile('bags-shoes', 'Bags & Shoes', 'luxury boutique sets and close-up material-rich framing'),
  'jewelry-watches': buildProfile('jewelry-watches', 'Jewelry & Watches', 'macro-grade highlights and refined reflective surfaces'),
  'health-beauty-hair': buildProfile('health-beauty-hair', 'Health, Beauty & Hair', 'clean beauty studio scenes with premium props'),
  'home-garden-furniture': buildProfile('home-garden-furniture', 'Home, Garden & Furniture', 'stylish interior staging with balanced ambient light'),
  'toys-kids-babies': buildProfile('toys-kids-babies', 'Toys, Kids & Babies', 'family-friendly bright scenes with safe premium styling'),
  'sports-outdoors': buildProfile('sports-outdoors', 'Sports & Outdoors', 'dynamic outdoor premium environments and action composition'),
  'consumer-electronics': buildProfile('consumer-electronics', 'Consumer Electronics', 'futuristic clean studio scenes and controlled reflections'),
  'home-improvement': buildProfile('home-improvement', 'Home Improvement', 'architectural environments with practical premium context'),
  'automobiles-motorcycles': buildProfile('automobiles-motorcycles', 'Automobiles & Motorcycles', 'high-end automotive lifestyle backgrounds'),
  'phones-accessories': buildProfile('phones-accessories', 'Phones & Accessories', 'sleek tech scenes with polished premium lighting'),
  'computer-office': buildProfile('computer-office', 'Computer & Office', 'modern workspace aesthetics and minimal design styling'),
  'pet-supplies': buildProfile('pet-supplies', 'Pet Supplies', 'warm premium lifestyle sets and playful but clean composition'),
}

const DEFAULT_PROFILE = buildProfile('general', 'General', 'premium product-first composition')

function normalizeSlug(input?: string): string {
  return String(input || '').trim().toLowerCase()
}

export function resolveAIMediaCategoryProfile(input: {
  categorySlug?: string
  categoryLabel?: string
}): AIMediaCategoryProfile {
  const directSlug = normalizeSlug(input.categorySlug)
  if (directSlug && PROFILE_MAP[directSlug]) return PROFILE_MAP[directSlug]

  const label = String(input.categoryLabel || '').trim()
  if (label) {
    const slugFromInput = slugFromLabel(label)
    if (PROFILE_MAP[slugFromInput]) return PROFILE_MAP[slugFromInput]

    const category = CATEGORIES.find((c) => c.label.toLowerCase() === label.toLowerCase())
    if (category && PROFILE_MAP[category.slug]) return PROFILE_MAP[category.slug]
  }

  if (directSlug) {
    const fallbackLabel = labelFromSlug(directSlug) || input.categoryLabel || 'General'
    return buildProfile(directSlug, fallbackLabel, 'premium product-first composition')
  }

  return DEFAULT_PROFILE
}

export function listAIMediaCategoryProfiles(): AIMediaCategoryProfile[] {
  return Object.values(PROFILE_MAP)
}
