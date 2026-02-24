-- Ensure strict 4K video delivery metadata columns exist on products + queue.
-- Idempotent and safe to run in all environments.

alter table if exists public.products
  add column if not exists video_url text,
  add column if not exists video_source_url text,
  add column if not exists video_4k_url text,
  add column if not exists video_delivery_mode text,
  add column if not exists video_quality_gate_passed boolean,
  add column if not exists video_source_quality_hint text,
  add column if not exists media_mode text,
  add column if not exists has_video boolean default false;

alter table if exists public.product_queue
  add column if not exists video_url text,
  add column if not exists video_source_url text,
  add column if not exists video_4k_url text,
  add column if not exists video_delivery_mode text,
  add column if not exists video_quality_gate_passed boolean,
  add column if not exists video_source_quality_hint text,
  add column if not exists media_mode text,
  add column if not exists has_video boolean default false;

create index if not exists idx_products_video_quality_gate_passed
  on public.products(video_quality_gate_passed);
create index if not exists idx_product_queue_video_quality_gate_passed
  on public.product_queue(video_quality_gate_passed);
