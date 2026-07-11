
create extension if not exists pg_trgm;

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  created_at timestamptz not null default now()
);
create table public.exam_types (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  created_at timestamptz not null default now()
);
create table public.academic_years (
  id uuid primary key default gen_random_uuid(),
  label text unique not null,
  created_at timestamptz not null default now()
);
create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  department text,
  created_at timestamptz not null default now(),
  unique (name, department)
);

do $$ begin
  create type public.paper_source as enum ('upload', 'gdrive');
exception when duplicate_object then null; end $$;

create table public.papers (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  department text not null,
  semester int not null check (semester between 1 and 8),
  academic_year text not null,
  exam_type text not null,
  marks int not null,
  exam_date date,
  description text,
  question_paper_source public.paper_source not null,
  question_paper_url text not null,
  answer_key_source public.paper_source,
  answer_key_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index papers_subject_trgm on public.papers using gin (subject gin_trgm_ops);
create index papers_desc_trgm on public.papers using gin (description gin_trgm_ops);
create index papers_department_idx on public.papers (department);
create index papers_semester_idx on public.papers (semester);
create index papers_academic_year_idx on public.papers (academic_year);
create index papers_exam_type_idx on public.papers (exam_type);
create index papers_created_idx on public.papers (created_at desc);

grant select, insert, update, delete on public.papers to anon, authenticated;
grant all on public.papers to service_role;
grant select, insert, update, delete on public.departments to anon, authenticated;
grant all on public.departments to service_role;
grant select, insert, update, delete on public.exam_types to anon, authenticated;
grant all on public.exam_types to service_role;
grant select, insert, update, delete on public.academic_years to anon, authenticated;
grant all on public.academic_years to service_role;
grant select, insert, update, delete on public.subjects to anon, authenticated;
grant all on public.subjects to service_role;

alter table public.papers enable row level security;
alter table public.departments enable row level security;
alter table public.exam_types enable row level security;
alter table public.academic_years enable row level security;
alter table public.subjects enable row level security;

create policy "papers public read" on public.papers for select using (true);
create policy "papers public insert" on public.papers for insert with check (true);
create policy "papers public update" on public.papers for update using (true) with check (true);
create policy "papers public delete" on public.papers for delete using (true);

create policy "departments public read" on public.departments for select using (true);
create policy "departments public insert" on public.departments for insert with check (true);
create policy "departments public update" on public.departments for update using (true) with check (true);
create policy "departments public delete" on public.departments for delete using (true);

create policy "exam_types public read" on public.exam_types for select using (true);
create policy "exam_types public insert" on public.exam_types for insert with check (true);
create policy "exam_types public update" on public.exam_types for update using (true) with check (true);
create policy "exam_types public delete" on public.exam_types for delete using (true);

create policy "academic_years public read" on public.academic_years for select using (true);
create policy "academic_years public insert" on public.academic_years for insert with check (true);
create policy "academic_years public update" on public.academic_years for update using (true) with check (true);
create policy "academic_years public delete" on public.academic_years for delete using (true);

create policy "subjects public read" on public.subjects for select using (true);
create policy "subjects public insert" on public.subjects for insert with check (true);
create policy "subjects public update" on public.subjects for update using (true) with check (true);
create policy "subjects public delete" on public.subjects for delete using (true);

create or replace function public.tg_papers_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger papers_updated_at before update on public.papers
for each row execute function public.tg_papers_updated_at();
