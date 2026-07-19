ALTER TABLE public.papers 
ADD COLUMN IF NOT EXISTS question_paper_file_id text,
ADD COLUMN IF NOT EXISTS question_paper_checksum text,
ADD COLUMN IF NOT EXISTS question_paper_modified_time timestamptz,
ADD COLUMN IF NOT EXISTS question_paper_size bigint,
ADD COLUMN IF NOT EXISTS answer_key_file_id text,
ADD COLUMN IF NOT EXISTS answer_key_checksum text,
ADD COLUMN IF NOT EXISTS answer_key_modified_time timestamptz,
ADD COLUMN IF NOT EXISTS answer_key_size bigint;

CREATE TABLE IF NOT EXISTS public.learned_aliases (
  alias text PRIMARY KEY,
  full_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.learned_aliases ENABLE ROW LEVEL SECURITY;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'learned_aliases' AND policyname = 'learned_aliases_read'
  ) THEN
    CREATE POLICY "learned_aliases_read" ON public.learned_aliases FOR SELECT USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'learned_aliases' AND policyname = 'learned_aliases_admin'
  ) THEN
    CREATE POLICY "learned_aliases_admin" ON public.learned_aliases FOR ALL TO authenticated USING ((auth.jwt() ->> 'role') = 'admin');
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.learned_aliases TO anon, authenticated;
GRANT ALL ON public.learned_aliases TO service_role;
