-- Create bulk_import_jobs table
CREATE TABLE IF NOT EXISTS bulk_import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL CHECK (status IN ('scanning', 'processing', 'paused', 'completed', 'failed', 'cancelled')),
  folder_url TEXT NOT NULL,
  current_step TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create bulk_import_items table
CREATE TABLE IF NOT EXISTS bulk_import_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES bulk_import_jobs(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  size BIGINT,
  web_view_link TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'skipped')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  type TEXT NOT NULL,
  error TEXT,
  used_ai BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE bulk_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_import_items ENABLE ROW LEVEL SECURITY;

-- Admin policies
CREATE POLICY "Admins can do everything on bulk_import_jobs"
ON bulk_import_jobs
FOR ALL
TO authenticated
USING (
  (auth.jwt() ->> 'role') = 'admin'
)
WITH CHECK (
  (auth.jwt() ->> 'role') = 'admin'
);

CREATE POLICY "Admins can do everything on bulk_import_items"
ON bulk_import_items
FOR ALL
TO authenticated
USING (
  (auth.jwt() ->> 'role') = 'admin'
)
WITH CHECK (
  (auth.jwt() ->> 'role') = 'admin'
);
