import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { hasTable } from '@/lib/db-features';

export type JobKind = 'finder' | 'import' | 'sync' | 'scanner' | 'media';
export type JobStatus = 'pending' | 'running' | 'success' | 'error' | 'canceled';
export type JobItemStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'canceled';

function getAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

async function ensureJobsTables(): Promise<boolean> {
  const hasJobs = await hasTable('admin_jobs');
  if (!hasJobs) return false;
  const hasItems = await hasTable('admin_job_items');
  return hasItems;
}

export async function patchJob(id: number, patch: Partial<{ params: any; totals: any; status: JobStatus; started_at: string; finished_at: string; error_text: string }>): Promise<boolean> {
  const db = getAdmin();
  if (!db) return false;
  const { error } = await db
    .from('admin_jobs')
    .update(patch as any)
    .eq('id', id);
  return !error;
}

export async function createJob(kind: JobKind, params?: any): Promise<{ id: number } | null> {
  const db = getAdmin();
  if (!db) return null;
  const { data, error } = await db
    .from('admin_jobs')
    .insert({ kind, status: 'pending', params: params || null })
    .select('id')
    .single();
  if (error || !data) return null;
  return { id: data.id as number };
}

export async function startJob(id: number): Promise<boolean> {
  const db = getAdmin();
  if (!db) return false;
  const { error } = await db
    .from('admin_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', id);
  return !error;
}

export async function finishJob(id: number, status: Exclude<JobStatus, 'pending' | 'running'>, totals?: any, errorText?: string): Promise<boolean> {
  const db = getAdmin();
  if (!db) return false;
  const { error } = await db
    .from('admin_jobs')
    .update({ status, finished_at: new Date().toISOString(), totals: totals || null, error_text: errorText || null })
    .eq('id', id);
  return !error;
}

export async function addJobItem(jobId: number, input: {
  status?: JobItemStatus;
  step?: string | null;
  cj_product_id?: string | null;
  cj_sku?: string | null;
  result?: any;
  error_text?: string | null;
}): Promise<{ id: number } | null> {
  const db = getAdmin();
  if (!db) return null;
  const row = {
    job_id: jobId,
    status: input.status || 'pending',
    step: input.step || null,
    cj_product_id: input.cj_product_id || null,
    cj_sku: input.cj_sku || null,
    result: input.result || null,
    error_text: input.error_text || null,
  };
  const { data, error } = await db
    .from('admin_job_items')
    .insert(row)
    .select('id')
    .single();
  if (error || !data) return null;
  return { id: data.id as number };
}

export async function updateJobItem(id: number, patch: Partial<{ status: JobItemStatus; step: string | null; result: any; error_text: string | null; started_at: string; finished_at: string }>): Promise<boolean> {
  const db = getAdmin();
  if (!db) return false;
  const { error } = await db
    .from('admin_job_items')
    .update(patch as any)
    .eq('id', id);
  return !error;
}

export async function cancelJob(id: number): Promise<boolean> {
  const db = getAdmin();
  if (!db) return false;
  const { data, error } = await db
    .from('admin_jobs')
    .update({ status: 'canceled', finished_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', ['pending', 'running'])
    .select('id')
    .maybeSingle();
  return !error && Boolean((data as any)?.id);
}

export async function getJob(id: number): Promise<any | null> {
  const db = getAdmin();
  if (!db) return null;
  const { data: job } = await db.from('admin_jobs').select('*').eq('id', id).maybeSingle();
  if (!job) return null;
  const { data: items } = await db.from('admin_job_items').select('*').eq('job_id', id).order('id', { ascending: true });
  return { job, items: items || [] };
}

export async function listJobs(limit = 50): Promise<{ jobs: any[]; tablesMissing?: boolean }> {
  const db = getAdmin();
  if (!db) return { jobs: [], tablesMissing: true };
  const tablesExist = await ensureJobsTables();
  if (!tablesExist) return { jobs: [], tablesMissing: true };
  const { data } = await db
    .from('admin_jobs')
    .select('id, created_at, kind, status, started_at, finished_at, totals, error_text')
    .order('created_at', { ascending: false })
    .limit(limit);
  return { jobs: data || [] };
}

export async function upsertJobItemByPid(jobId: number, cj_product_id: string, input: Partial<{ status: JobItemStatus; step: string | null; result: any; error_text: string | null }>): Promise<{ id: number } | null> {
  const db = getAdmin();
  if (!db) return null;
  const { data: exist } = await db
    .from('admin_job_items')
    .select('id')
    .eq('job_id', jobId)
    .eq('cj_product_id', cj_product_id)
    .maybeSingle();
  if (exist?.id) {
    const { error } = await db
      .from('admin_job_items')
      .update({
        status: input.status || 'pending',
        step: typeof input.step === 'undefined' ? null : input.step,
        result: typeof input.result === 'undefined' ? null : input.result,
        error_text: typeof input.error_text === 'undefined' ? null : input.error_text,
      } as any)
      .eq('id', exist.id);
    if (error) return null;
    return { id: exist.id as number };
  }
  return await addJobItem(jobId, { status: input.status || 'pending', step: input.step || null, cj_product_id, cj_sku: undefined, result: input.result || null, error_text: input.error_text || null });
}
