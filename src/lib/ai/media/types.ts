export type AIMediaSourceContext = 'discover' | 'cj_detail' | 'queue' | 'product';

export type AIMediaRunStatus =
  | 'pending'
  | 'running'
  | 'partial'
  | 'completed'
  | 'failed'
  | 'canceled';

export type AIMediaAssetStatus = 'ready' | 'rejected' | 'archived';
export type AIMediaType = 'image' | 'video';
export type AIMediaResolutionPreset = '2k' | '4k';
export type AIMediaRenderMode = 'background_only_preserve_product' | 'pose_aware_model_wear';
export type AIMediaViewTag = 'front' | 'back' | 'side' | 'detail' | 'unknown';
export type AIMediaFaceVisibility = 'half_face_allowed' | 'face_hidden';

export interface AIMediaFaceVisibilityPolicy {
  upperWear: AIMediaFaceVisibility;
  fullBody: AIMediaFaceVisibility;
}

export interface CreateAIMediaRunRequest {
  cjProductId: string;
  sourceContext: AIMediaSourceContext;
  targetColors?: string[];
  sourceImages?: string[];
  sourceVideoUrl?: string;
  colorImageMap?: Record<string, string>;
  queueProductId?: number;
  productId?: number;
  createdBy?: string;
  imagesPerColor?: number;
  includeVideo?: boolean;
  resolutionPreset?: AIMediaResolutionPreset;
  categorySlug?: string;
  categoryLabel?: string;
  preferredVisualStyle?: string;
  luxuryPresentation?: boolean;
  renderMode?: AIMediaRenderMode;
  allowedViews?: AIMediaViewTag[];
  sourceViewMap?: Record<string, AIMediaViewTag>;
  enforceSourceViewOnly?: boolean;
  faceVisibilityPolicy?: Partial<AIMediaFaceVisibilityPolicy>;
}

export interface AIMediaQualityContract {
  imagesPerColor: number;
  includeVideo: boolean;
  resolutionPreset: AIMediaResolutionPreset;
  outputWidth: number;
  outputHeight: number;
  strictProductFidelity: true;
  forbidProductEdits: string[];
  requiredChecks: string[];
}

export interface NormalizedAIMediaRunRequest {
  cjProductId: string;
  sourceContext: AIMediaSourceContext;
  targetColors: string[];
  sourceImages: string[];
  sourceVideoUrl?: string;
  colorImageMap: Record<string, string>;
  queueProductId?: number;
  productId?: number;
  createdBy?: string;
  categorySlug?: string;
  categoryLabel?: string;
  preferredVisualStyle?: string;
  luxuryPresentation: boolean;
  renderMode: AIMediaRenderMode;
  allowedViews: AIMediaViewTag[];
  sourceViewMap: Record<string, AIMediaViewTag>;
  enforceSourceViewOnly: boolean;
  faceVisibilityPolicy: AIMediaFaceVisibilityPolicy;
  quality: AIMediaQualityContract;
}

export interface AIMediaRunRecord {
  id: number;
  cj_product_id: string;
  queue_product_id: number | null;
  product_id: number | null;
  source_context: AIMediaSourceContext;
  status: AIMediaRunStatus;
  requested_images_per_color: number;
  include_video: boolean;
  category_profile: string | null;
  params: Record<string, any>;
  totals: Record<string, any>;
  error_text: string | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface AIMediaAssetRecord {
  id: number;
  run_id: number;
  cj_product_id: string;
  queue_product_id: number | null;
  product_id: number | null;
  color: string;
  media_type: AIMediaType;
  media_index: number | null;
  storage_url: string;
  provider: string | null;
  provider_asset_id: string | null;
  prompt_snapshot: Record<string, any> | null;
  fidelity: Record<string, any> | null;
  status: AIMediaAssetStatus;
  created_at: string;
}

export interface AIMediaFidelityCheck {
  key: string;
  score: number;
  required: boolean;
  passed: boolean;
  reason?: string;
}

export interface AIMediaFidelityResult {
  strictPass: boolean;
  overallScore: number;
  checks: AIMediaFidelityCheck[];
  summary: string;
  rejectionReasons?: string[];
}

export interface AIMediaColorProgress {
  color: string;
  approvedImages: number;
  rejectedImages: number;
  approvedVideo: number;
  rejectedVideo: number;
  done: boolean;
}

export interface AIMediaRunDetails {
  run: AIMediaRunRecord;
  assets: AIMediaAssetRecord[];
  byColor: AIMediaColorProgress[];
  jobId: number | null;
}

export interface CreateAIMediaRunResult {
  runId: number;
  jobId: number | null;
  status: AIMediaRunStatus;
}
