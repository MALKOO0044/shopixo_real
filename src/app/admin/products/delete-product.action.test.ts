// @ts-nocheck

const mockGetUser = jest.fn();
const mockCreateClient = jest.fn();
const mockRedirect = jest.fn();
const mockRevalidatePath = jest.fn();

jest.mock('@supabase/auth-helpers-nextjs', () => ({
  createServerComponentClient: jest.fn(() => ({
    auth: {
      getUser: mockGetUser,
    },
  })),
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: any[]) => mockCreateClient(...args),
}));

jest.mock('next/navigation', () => ({
  redirect: (path: string) => mockRedirect(path),
}));

jest.mock('next/cache', () => ({
  revalidatePath: (path: string) => mockRevalidatePath(path),
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(() => ({})),
}));

import { deleteProduct } from '@/app/admin/products/actions';

function buildSupabaseMock(options: {
  deleteError: any;
  archiveError?: any;
  stockOnlyError?: any;
}) {
  const updatePayloads: any[] = [];

  const supabase = {
    from: jest.fn((table: string) => {
      if (table === 'cart_items') {
        return {
          delete: () => ({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }

      if (table === 'products') {
        return {
          delete: () => ({
            eq: jest.fn().mockResolvedValue({ error: options.deleteError }),
          }),
          update: (payload: any) => {
            updatePayloads.push(payload);
            const isArchiveAttempt = Object.prototype.hasOwnProperty.call(payload, 'is_active');
            const error = isArchiveAttempt
              ? (options.archiveError ?? null)
              : (options.stockOnlyError ?? null);
            return {
              eq: jest.fn().mockResolvedValue({ error }),
            };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }),
  };

  return { supabase, updatePayloads };
}

describe('deleteProduct action fallback behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';
    process.env.ADMIN_EMAILS = 'admin@example.com';

    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'admin@example.com' } },
    });
  });

  it('archives product when hard delete is blocked by order FK', async () => {
    const { supabase, updatePayloads } = buildSupabaseMock({
      deleteError: { code: '23503', message: 'foreign key violation' },
      archiveError: null,
    });
    mockCreateClient.mockReturnValue(supabase as any);

    const formData = new FormData();
    formData.set('id', '101');

    const result = await deleteProduct({ error: null, success: false }, formData);

    expect(result).toEqual({ error: null, success: true });
    expect(updatePayloads).toContainEqual({ is_active: false, stock: 0 });
    expect(mockRevalidatePath).toHaveBeenCalledWith('/sale');
    expect(mockRevalidatePath).toHaveBeenCalledWith('/new-arrivals');
    expect(mockRevalidatePath).toHaveBeenCalledWith('/bestsellers');
    expect(mockRedirect).toHaveBeenCalledWith('/admin/products');
  });

  it('falls back to stock-only update when is_active column is unavailable', async () => {
    const { supabase, updatePayloads } = buildSupabaseMock({
      deleteError: { code: '23503', message: 'foreign key violation' },
      archiveError: { code: '42703', message: 'column "is_active" does not exist' },
      stockOnlyError: null,
    });
    mockCreateClient.mockReturnValue(supabase as any);

    const formData = new FormData();
    formData.set('id', '102');

    const result = await deleteProduct({ error: null, success: false }, formData);

    expect(result).toEqual({ error: null, success: true });
    expect(updatePayloads).toEqual([
      { is_active: false, stock: 0 },
      { stock: 0 },
    ]);
    expect(mockRedirect).toHaveBeenCalledWith('/admin/products');
  });

  it('returns explicit error when archive fallback also fails', async () => {
    const { supabase } = buildSupabaseMock({
      deleteError: { code: '23503', message: 'foreign key violation' },
      archiveError: { code: '50000', message: 'update failed' },
    });
    mockCreateClient.mockReturnValue(supabase as any);

    const formData = new FormData();
    formData.set('id', '103');

    const result = await deleteProduct({ error: null, success: false }, formData);

    expect(result).toEqual({
      error: 'Database error: Could not archive product after delete restriction.',
      success: false,
    });
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
