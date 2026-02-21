-- AI media generation core tables + compatibility extensions (idempotent)

-- 1) Run-level tracking
create table if not exists public.ai_media_runs (
  id bigserial primary key,
  cj_product_id text not null,
  queue_product_id bigint null references public.product_queue(id) on delete set null,
  product_id bigint null references public.products(id) on delete set null,
  source_context text not null check (source_context in ('discover', 'cj_detail', 'queue', 'product')),
  status text not null default 'pending' check (status in ('pending', 'running', 'partial', 'completed', 'failed', 'canceled')),
  requested_images_per_color integer not null default 6,
  include_video boolean not null default true,
  category_profile text,
  params jsonb not null default '{}'::jsonb,
  totals jsonb not null default '{}'::jsonb,
  error_text text,
  created_by text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists idx_ai_media_runs_cj_created on public.ai_media_runs(cj_product_id, created_at desc);
create index if not exists idx_ai_media_runs_status_created on public.ai_media_runs(status, created_at desc);

alter table public.ai_media_runs enable row level security;
drop policy if exists "Service role can manage ai_media_runs" on public.ai_media_runs;
create policy "Service role can manage ai_media_runs" on public.ai_media_runs
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- 2) Asset-level tracking
create table if not exists public.ai_media_assets (
  id bigserial primary key,
  run_id bigint not null references public.ai_media_runs(id) on delete cascade,
  cj_product_id text not null,
  queue_product_id bigint null references public.product_queue(id) on delete set null,
  product_id bigint null references public.products(id) on delete set null,
  color text not null,
  media_type text not null check (media_type in ('image', 'video')),
  media_index integer,
  storage_url text not null,
  provider text,
  provider_asset_id text,
  prompt_snapshot jsonb,
  fidelity jsonb,
  status text not null default 'ready' check (status in ('ready', 'rejected', 'archived')),
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_media_assets_cj_color_type on public.ai_media_assets(cj_product_id, color, media_type);
create index if not exists idx_ai_media_assets_run_type_index on public.ai_media_assets(run_id, media_type, media_index);

alter table public.ai_media_assets enable row level security;
drop policy if exists "Service role can manage ai_media_assets" on public.ai_media_assets;
create policy "Service role can manage ai_media_assets" on public.ai_media_assets
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- 3) Compatibility columns for ai_actions (required by src/lib/ai/action-logger.ts)
alter table if exists public.ai_actions
  add column if not exists entity_type text,
  add column if not exists entity_id text,
  add column if not exists action_data jsonb default '{}'::jsonb,
  add column if not exists confidence_score numeric(5,4),
  add column if not exists can_rollback boolean not null default false,
  add column if not exists rolled_back boolean not null default false,
  add column if not exists completed_at timestamptz;

create index if not exists idx_ai_actions_entity on public.ai_actions(entity_type, entity_id);

-- 4) Extend admin_jobs kind enum/check to include media jobs
alter table if exists public.admin_jobs
  drop constraint if exists admin_jobs_kind_check;

alter table if exists public.admin_jobs
  add constraint admin_jobs_kind_check
  check (kind in ('finder', 'import', 'sync', 'scanner', 'media'));
