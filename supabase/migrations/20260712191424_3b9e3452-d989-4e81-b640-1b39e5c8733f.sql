
CREATE TABLE public.feedbacks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT,
  email TEXT,
  message TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feedbacks TO anon, authenticated;
GRANT ALL ON public.feedbacks TO service_role;
ALTER TABLE public.feedbacks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "feedbacks public insert" ON public.feedbacks FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "feedbacks public read" ON public.feedbacks FOR SELECT TO public USING (true);
CREATE POLICY "feedbacks public delete" ON public.feedbacks FOR DELETE TO public USING (true);
