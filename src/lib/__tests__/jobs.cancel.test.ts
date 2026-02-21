// @ts-nocheck

const mockCreateClient = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: any[]) => mockCreateClient(...args),
}));

import { cancelJob } from '@/lib/jobs';

type CancelJobDbResult = {
  data: any;
  error: any;
};

function setupCancelJobDb(result: CancelJobDbResult) {
  const maybeSingle = jest.fn().mockResolvedValue(result);
  const select = jest.fn().mockReturnValue({ maybeSingle });
  const inFn = jest.fn().mockReturnValue({ select });
  const eq = jest.fn().mockReturnValue({ in: inFn });
  const update = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ update });

  mockCreateClient.mockReturnValue({ from });

  return {
    from,
    update,
    eq,
    inFn,
    select,
    maybeSingle,
  };
}

describe('cancelJob', () => {
  const prevUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  });

  afterAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = prevUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  });

  it('returns true when a pending/running row is canceled', async () => {
    const db = setupCancelJobDb({ data: { id: 42 }, error: null });

    await expect(cancelJob(42)).resolves.toBe(true);

    expect(db.from).toHaveBeenCalledWith('admin_jobs');
    expect(db.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'canceled',
        finished_at: expect.any(String),
      })
    );
    expect(db.eq).toHaveBeenCalledWith('id', 42);
    expect(db.inFn).toHaveBeenCalledWith('status', ['pending', 'running']);
    expect(db.select).toHaveBeenCalledWith('id');
    expect(db.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('returns false when no active row was updated', async () => {
    setupCancelJobDb({ data: null, error: null });

    await expect(cancelJob(42)).resolves.toBe(false);
  });

  it('returns false when the database update errors', async () => {
    setupCancelJobDb({ data: null, error: { message: 'db failed' } });

    await expect(cancelJob(42)).resolves.toBe(false);
  });

  it('returns false when admin env vars are missing', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(cancelJob(42)).resolves.toBe(false);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});
