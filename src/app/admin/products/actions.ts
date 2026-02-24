"use server";

import { createServerComponentClient } from "@supabase/auth-helpers-nextjs";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { productSchema } from "@/lib/schemas/product";

// productSchema is now defined in '@/lib/schemas/product' to avoid exporting
// non-async values from a 'use server' module.

export async function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

async function getCurrentUser() {
  const supabaseAuth = createServerComponentClient({ cookies });
  const { data: { user } } = await supabaseAuth.auth.getUser();
  return user;
}

async function canManageProduct(productId: number | null) {
  // Admins can always manage
  const adminCheck = await requireAdmin();
  if (adminCheck.allowed) return true;

  // If no productId, only allow if admin
  if (!productId) return false;

  const supabaseAdmin = await getSupabaseAdmin();
  if (!supabaseAdmin) return false;
  const user = await getCurrentUser();
  if (!user) return false;

  // Try to read owner column; if missing, fallback to admin-only
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("user_id")
    .eq("id", productId)
    .single();
  if (error && ((error as any).code === "42703" || String(error.message || "").includes("user_id"))) {
    // No owner column; cannot verify ownership
    return false;
  }
  const ownerId = (data as any)?.user_id as string | null;
  return !!ownerId && ownerId === user.id;
}

const setActiveSchema = z.object({
  id: z.coerce.number(),
  is_active: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => (v === "true" || v === true ? true : false)),
});

export async function setProductActive(prevState: { error: string | null; success: boolean }, formData: FormData) {
  const supabaseAdmin = await getSupabaseAdmin();
  if (!supabaseAdmin) {
    return { error: "Server misconfiguration: missing Supabase service role envs", success: false };
  }

  const validated = setActiveSchema.safeParse({
    id: formData.get("id"),
    is_active: formData.get("is_active"),
  });
  if (!validated.success) {
    return { error: "Invalid input.", success: false };
  }

  const { id, is_active } = validated.data;

  if (!(await canManageProduct(id))) {
    return { error: "Not authorized", success: false };
  }

  const { error } = await supabaseAdmin.from("products").update({ is_active }).eq("id", id);
  if (error) {
    console.error("setProductActive failed:", error);
    return { error: "Database error: Could not update product status.", success: false };
  }

  revalidatePath("/admin");
  revalidatePath("/admin/products");
  revalidatePath("/");
  revalidatePath("/shop");
  revalidatePath("/search");
  redirect("/admin/products");
}

async function requireAdmin() {
  const supabaseAuth = createServerComponentClient({ cookies });
  const { data: { user } } = await supabaseAuth.auth.getUser();
  if (!user) {
    return { allowed: false as const };
  }
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (adminEmails.length === 0) {
    // Default deny in production when unset; allow in development for DX
    return { allowed: process.env.NODE_ENV !== "production" } as const;
  }
  const email = (user.email || "").toLowerCase();
  return { allowed: !!email && adminEmails.includes(email) } as const;
}

export async function addProduct(prevState: any, formData: FormData) {
  const user = await getCurrentUser();
  if (!user) {
    return { message: "Not authorized", fieldErrors: null };
  }
  const supabaseAdmin = await getSupabaseAdmin();
  if (!supabaseAdmin) {
    return { message: "Server misconfiguration: missing Supabase service role envs", fieldErrors: null };
  }
  const validatedFields = productSchema.safeParse(Object.fromEntries(formData.entries()));

  if (!validatedFields.success) {
    return {
      message: "Invalid data",
      fieldErrors: validatedFields.error.flatten().fieldErrors,
    };
  }

  // Attach owner if products.user_id column exists
  let insertPayload: any = validatedFields.data;
  try {
    const probe = await supabaseAdmin.from("products").select("user_id").limit(1);
    if (!probe.error) {
      insertPayload = { ...insertPayload, user_id: user.id };
    }
  } catch {}

  // Probe for is_active column existence; omit it from payload if column is missing
  try {
    const probeActive = await supabaseAdmin.from("products").select("is_active").limit(1);
    if (probeActive.error) {
      const { is_active, ...rest } = insertPayload;
      insertPayload = rest;
    }
  } catch {
    const { is_active, ...rest } = insertPayload;
    insertPayload = rest;
  }

  const { error } = await supabaseAdmin.from("products").insert(insertPayload);

  if (error) {
    // Provide a clearer, admin-friendly message (e.g., unique violation on slug)
    console.error("Add product failed:", error);
    const friendlyMessage =
      error.code === "23505"
        ? "Slug already exists. Please use a unique slug."
        : error.message || "Database error: Could not add product.";
    return { message: friendlyMessage, fieldErrors: null };
  }

  revalidatePath("/admin");
  revalidatePath("/admin/products");
  redirect("/admin/products");
}

const productUpdateSchema = productSchema.extend({
  id: z.coerce.number(),
});

export async function updateProduct(prevState: any, formData: FormData) {
  const user = await getCurrentUser();
  if (!user) {
    return { message: "Not authorized", fieldErrors: null };
  }
  const supabaseAdmin = await getSupabaseAdmin();
  if (!supabaseAdmin) {
    return { message: "Server misconfiguration: missing Supabase service role envs", fieldErrors: null };
  }
  const validatedFields = productUpdateSchema.safeParse(Object.fromEntries(formData.entries()));

  if (!validatedFields.success) {
    return {
      message: "Invalid data",
      fieldErrors: validatedFields.error.flatten().fieldErrors,
    };
  }

  const { id, ...productData } = validatedFields.data;

  if (!(await canManageProduct(id))) {
    return { message: "Not authorized", fieldErrors: null };
  }

  // Omit is_active if column missing
  try {
    const probeActive = await supabaseAdmin.from("products").select("is_active").limit(1);
    if (probeActive.error) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { is_active, ...rest } = productData as any;
      (productData as any) = rest;
    }
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { is_active, ...rest } = productData as any;
    (productData as any) = rest;
  }

  const { error } = await supabaseAdmin.from("products").update(productData).eq("id", id);

  if (error) {
    console.error("Update product failed:", error);
    const friendlyMessage =
      error.code === "23505"
        ? "Slug already exists. Please use a unique slug."
        : error.message || "Database error: Could not update product.";
    return { message: friendlyMessage, fieldErrors: null };
  }

  revalidatePath("/admin");
  revalidatePath(`/admin/products/${id}/edit`);
  redirect("/admin");
}

const deleteProductSchema = z.object({
  id: z.coerce.number(),
});

export async function deleteProduct(prevState: { error: string | null; success: boolean }, formData: FormData) {
  const supabaseAdmin = await getSupabaseAdmin();
  if (!supabaseAdmin) {
    return { error: "Server misconfiguration: missing Supabase service role envs", success: false };
  }
  const validatedFields = deleteProductSchema.safeParse(Object.fromEntries(formData.entries()));

  if (!validatedFields.success) {
    return { error: "Invalid product ID.", success: false };
  }

  const { id } = validatedFields.data;

  if (!(await canManageProduct(id))) {
    return { error: "Not authorized", success: false };
  }

  // First, remove any cart_items referencing this product to avoid FK restrict
  const cartDel = await supabaseAdmin.from("cart_items").delete().eq("product_id", id);
  if (cartDel.error) {
    console.error("Failed to delete cart_items for product", id, cartDel.error);
  }

  // Attempt to delete the product
  const { error } = await supabaseAdmin.from("products").delete().eq("id", id);

  if (error) {
    console.error("Delete product failed:", error);
    // 23503 is foreign_key_violation in Postgres
    if ((error as any).code === "23503") {
      let archiveError: any = null;
      const archiveAttempt = await supabaseAdmin
        .from("products")
        .update({ is_active: false, stock: 0 })
        .eq("id", id);
      archiveError = archiveAttempt.error;

      if (archiveError && ((archiveError as any).code === "42703" || String(archiveError.message || "").includes("is_active"))) {
        const stockOnlyAttempt = await supabaseAdmin
          .from("products")
          .update({ stock: 0 })
          .eq("id", id);
        archiveError = stockOnlyAttempt.error;
      }

      if (archiveError) {
        console.error("Soft remove fallback failed:", archiveError);
        return { error: "Database error: Could not archive product after delete restriction.", success: false };
      }

      revalidatePath("/admin");
      revalidatePath("/admin/products");
      revalidatePath("/");
      revalidatePath("/shop");
      revalidatePath("/search");
      revalidatePath("/sale");
      revalidatePath("/new-arrivals");
      revalidatePath("/bestsellers");
      redirect("/admin/products");
      return { error: null, success: true };
    }
    return { error: "Database error: Could not delete product.", success: false };
  }

  revalidatePath("/admin");
  revalidatePath("/admin/products");
  redirect("/admin/products");
  return { error: null, success: true };
}
