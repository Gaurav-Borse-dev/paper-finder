
create policy "papers bucket public read"
on storage.objects for select
using (bucket_id = 'papers');

create policy "papers bucket public insert"
on storage.objects for insert
with check (bucket_id = 'papers');

create policy "papers bucket public update"
on storage.objects for update
using (bucket_id = 'papers') with check (bucket_id = 'papers');

create policy "papers bucket public delete"
on storage.objects for delete
using (bucket_id = 'papers');
