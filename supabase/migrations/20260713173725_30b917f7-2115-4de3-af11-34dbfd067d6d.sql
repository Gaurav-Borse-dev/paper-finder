
-- ============================================================
-- PaperVault: real auth, roles, RLS, feedback categories
-- ============================================================

-- 1. Roles enum + user_roles table
CREATE TYPE public.app_role AS ENUM ('admin', 'student');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own roles"
  ON public.user_roles FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- 2. has_role security-definer function (no recursion)
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- 3. Pending admin allow-list (seed emails that become admin on signup)
CREATE TABLE public.pending_admins (
  email text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.pending_admins TO authenticated;
GRANT ALL ON public.pending_admins TO service_role;
ALTER TABLE public.pending_admins ENABLE ROW LEVEL SECURITY;
-- no policies for anon/authenticated — only the trigger (security definer) reads it

INSERT INTO public.pending_admins (email) VALUES ('admin@papervault.app');

-- 4. Trigger: on new signup, assign admin if email in allow-list, else student
CREATE OR REPLACE FUNCTION public.handle_new_user_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.pending_admins WHERE lower(email) = lower(NEW.email)) THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin')
      ON CONFLICT DO NOTHING;
    DELETE FROM public.pending_admins WHERE lower(email) = lower(NEW.email);
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'student')
      ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_assign_role ON auth.users;
CREATE TRIGGER on_auth_user_created_assign_role
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_role();

-- 5. Papers: add extraction metadata columns
ALTER TABLE public.papers
  ADD COLUMN IF NOT EXISTS subject_code text,
  ADD COLUMN IF NOT EXISTS extraction_confidence jsonb;

-- 6. Feedback: add category + user_id
ALTER TABLE public.feedbacks
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.feedbacks
  ADD CONSTRAINT feedbacks_category_check
  CHECK (category IN ('bug', 'missing_paper', 'ui_issue', 'other'));

-- 7. Replace wide-open RLS policies with role-scoped ones
-- papers
DROP POLICY IF EXISTS "papers public read" ON public.papers;
DROP POLICY IF EXISTS "papers public insert" ON public.papers;
DROP POLICY IF EXISTS "papers public update" ON public.papers;
DROP POLICY IF EXISTS "papers public delete" ON public.papers;

CREATE POLICY "papers anyone read" ON public.papers FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "papers admin insert" ON public.papers FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "papers admin update" ON public.papers FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "papers admin delete" ON public.papers FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

GRANT SELECT ON public.papers TO anon;

-- departments / exam_types / academic_years / subjects (same pattern)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['departments','exam_types','academic_years','subjects']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%s public read" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s public insert" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s public update" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s public delete" ON public.%I', t, t);
    EXECUTE format('CREATE POLICY "%s anyone read" ON public.%I FOR SELECT TO anon, authenticated USING (true)', t, t);
    EXECUTE format('CREATE POLICY "%s admin insert" ON public.%I FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), ''admin''))', t, t);
    EXECUTE format('CREATE POLICY "%s admin update" ON public.%I FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), ''admin'')) WITH CHECK (public.has_role(auth.uid(), ''admin''))', t, t);
    EXECUTE format('CREATE POLICY "%s admin delete" ON public.%I FOR DELETE TO authenticated USING (public.has_role(auth.uid(), ''admin''))', t, t);
    EXECUTE format('GRANT SELECT ON public.%I TO anon', t);
  END LOOP;
END $$;

-- feedbacks: anyone can insert; only admins can read/delete
DROP POLICY IF EXISTS "feedbacks public read" ON public.feedbacks;
DROP POLICY IF EXISTS "feedbacks public insert" ON public.feedbacks;
DROP POLICY IF EXISTS "feedbacks public delete" ON public.feedbacks;

CREATE POLICY "feedbacks anyone insert" ON public.feedbacks FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "feedbacks admin read" ON public.feedbacks FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "feedbacks admin delete" ON public.feedbacks FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

GRANT INSERT ON public.feedbacks TO anon;

-- 8. Storage: papers bucket — admin-only writes, admins can read raw
-- (public reads still go through signed URLs from server functions)
DROP POLICY IF EXISTS "papers bucket admin insert" ON storage.objects;
DROP POLICY IF EXISTS "papers bucket admin update" ON storage.objects;
DROP POLICY IF EXISTS "papers bucket admin delete" ON storage.objects;
DROP POLICY IF EXISTS "papers bucket admin read"   ON storage.objects;

CREATE POLICY "papers bucket admin insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'papers' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "papers bucket admin update" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'papers' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "papers bucket admin delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'papers' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "papers bucket admin read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'papers' AND public.has_role(auth.uid(), 'admin'));
