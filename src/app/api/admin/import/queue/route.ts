import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { calculateRetailSar, usdToSar } from "@/lib/pricing";

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FIXED_PROFIT_MARGIN_PERCENT = 42;

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function isDbConfigured(): boolean {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export async function GET(req: NextRequest) {
  try {
    if (!isDbConfigured()) {
      return NextResponse.json({ ok: false, error: "Database not configured" }, { status: 500 });
    }

    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return NextResponse.json({ ok: false, error: "Database connection failed" }, { status: 500 });
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status") || "pending";
    const batchId = searchParams.get("batch_id");
    const category = searchParams.get("category");
    const queueIdParam = searchParams.get("queue_id");
    const cjProductId = (searchParams.get("cj_product_id") || "").trim();
    const limit = Math.min(100, Number(searchParams.get("limit") || 50));
    const offset = Number(searchParams.get("offset") || 0);
    const queueId = Number(queueIdParam);
    const hasQueueIdFilter = Number.isFinite(queueId) && queueId > 0;

    let query = supabase.from('product_queue').select('*');
    
    if (hasQueueIdFilter) {
      query = query.eq('id', Math.floor(queueId));
    }
    if (cjProductId) {
      query = query.eq('cj_product_id', cjProductId);
    }
    if (status !== "all") {
      query = query.eq('status', status);
    }
    if (batchId) {
      query = query.eq('batch_id', Number(batchId));
    }
    if (category && category !== "all") {
      query = query.eq('category', category);
    }

    query = query.order('quality_score', { ascending: false })
                 .order('created_at', { ascending: false })
                 .range(offset, offset + limit - 1);

    const { data: products, error: queryError } = await query;

    if (queryError) {
      console.error("[Queue GET] Query error:", queryError);
      if (queryError.message.includes('does not exist')) {
        return NextResponse.json({ 
          ok: false, 
          error: "Import tables not found. Please run the database migration first." 
        }, { status: 500 });
      }
      return NextResponse.json({ ok: false, error: queryError.message }, { status: 500 });
    }

    const { count: totalCount } = await supabase
      .from('product_queue')
      .select('*', { count: 'exact', head: true })
      .eq('status', status === "all" ? "pending" : status);

    const [pendingRes, approvedRes, rejectedRes, importedRes] = await Promise.all([
      supabase.from('product_queue').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('product_queue').select('*', { count: 'exact', head: true }).eq('status', 'approved'),
      supabase.from('product_queue').select('*', { count: 'exact', head: true }).eq('status', 'rejected'),
      supabase.from('product_queue').select('*', { count: 'exact', head: true }).eq('status', 'imported'),
    ]);

    const stats = {
      pending: pendingRes.count || 0,
      approved: approvedRes.count || 0,
      rejected: rejectedRes.count || 0,
      imported: importedRes.count || 0,
    };

    return NextResponse.json({
      ok: true,
      products: products || [],
      total: totalCount || 0,
      stats,
    });
  } catch (e: any) {
    console.error("[Queue GET] Error:", e);
    return NextResponse.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    if (!isDbConfigured()) {
      return NextResponse.json({ ok: false, error: "Database not configured" }, { status: 500 });
    }

    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return NextResponse.json({ ok: false, error: "Database connection failed" }, { status: 500 });
    }

    const body = await req.json();
    const { ids, action, data } = body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ ok: false, error: "No product IDs provided" }, { status: 400 });
    }

    let updateData: Record<string, any> = { updated_at: new Date().toISOString() };

    switch (action) {
      case "approve":
        updateData.status = 'approved';
        updateData.reviewed_at = new Date().toISOString();
        break;
      case "reject":
        updateData.status = 'rejected';
        updateData.reviewed_at = new Date().toISOString();
        break;
      case "pending":
        updateData.status = 'pending';
        updateData.reviewed_at = null;
        break;
      case "update":
        if (data) {
          if (data.name_en) updateData.name_en = data.name_en;
          if (data.name_ar) updateData.name_ar = data.name_ar;
          if (data.description_en) updateData.description_en = data.description_en;
          if (data.description_ar) updateData.description_ar = data.description_ar;
          if (data.category) updateData.category = data.category;
          if (data.admin_notes !== undefined) updateData.admin_notes = data.admin_notes;
          if (data.calculated_retail_sar) updateData.calculated_retail_sar = data.calculated_retail_sar;
          updateData.margin_applied = FIXED_PROFIT_MARGIN_PERCENT;
        }
        break;
      default:
        return NextResponse.json({ ok: false, error: "Invalid action" }, { status: 400 });
    }

    const { error: updateError } = await supabase
      .from('product_queue')
      .update(updateData)
      .in('id', ids);

    if (updateError) {
      console.error("[Queue PATCH] Update error:", updateError);
      return NextResponse.json({ ok: false, error: updateError.message }, { status: 500 });
    }

    try {
      await supabase.from('import_logs').insert({
        action: `queue_${action}`,
        status: 'success',
        details: { ids, action, data }
      });
    } catch (logErr) {
      console.error("[Queue PATCH] Log error:", logErr);
    }

    return NextResponse.json({ ok: true, updated: ids.length });
  } catch (e: any) {
    console.error("[Queue PATCH] Error:", e);
    return NextResponse.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    if (!isDbConfigured()) {
      return NextResponse.json({ ok: false, error: "Database not configured" }, { status: 500 });
    }

    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return NextResponse.json({ ok: false, error: "Database connection failed" }, { status: 500 });
    }

    const { searchParams } = new URL(req.url);
    const idsParam = searchParams.get("ids");

    if (!idsParam) {
      return NextResponse.json({ ok: false, error: "No IDs provided" }, { status: 400 });
    }

    const ids = idsParam.split(",").map(Number).filter(n => !isNaN(n));
    if (ids.length === 0) {
      return NextResponse.json({ ok: false, error: "Invalid IDs" }, { status: 400 });
    }

    const { error: deleteError } = await supabase
      .from('product_queue')
      .delete()
      .in('id', ids);

    if (deleteError) {
      console.error("[Queue DELETE] Delete error:", deleteError);
      return NextResponse.json({ ok: false, error: deleteError.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, deleted: ids.length });
  } catch (e: any) {
    console.error("[Queue DELETE] Error:", e);
    return NextResponse.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
  }
}
