-- Weekly history for product_rating_review_metrics.
--
-- product_rating_review_metrics holds only the LATEST snapshot (one row per SKU per
-- platform). Every write to it is copied into product_rating_review_history keyed by
-- snapshot_date, so replacing the latest data each week never loses the old week.
--
-- How the snapshot date is chosen:
--   - replace_product_rating_metrics(rows, date) sets it explicitly (the dashboard upload).
--   - Any other write (Supabase CSV import, script, manual edit) uses today's IST date.
-- Loading the same date twice replaces that date's snapshot rather than duplicating it.

create table if not exists public.product_rating_review_history (
  id bigint generated always as identity primary key,
  snapshot_date date not null,
  platform text not null,
  sku_key text not null,               -- sku_id, or 'name:<product_name>' when sku_id is blank
  sku_id text,
  master_product_skuid text,
  product_name text not null,
  price numeric,
  rating numeric,
  review_count integer,
  captured_at timestamptz not null default now(),
  unique (snapshot_date, platform, sku_key)
);

create index if not exists product_rating_review_history_date_idx
  on public.product_rating_review_history (snapshot_date desc);

alter table public.product_rating_review_history enable row level security;
drop policy if exists "read rating history" on public.product_rating_review_history;
create policy "read rating history" on public.product_rating_review_history
  for select to anon, authenticated using (true);

create or replace function public.product_rating_snapshot_date()
returns date language sql stable as $$
  select coalesce(nullif(current_setting('app.rating_snapshot_date', true), '')::date,
                  (now() at time zone 'Asia/Kolkata')::date)
$$;

create or replace function public.trg_capture_rating_history()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.product_rating_review_history
    (snapshot_date, platform, sku_key, sku_id, master_product_skuid, product_name, price, rating, review_count)
  values (
    public.product_rating_snapshot_date(),
    trim(new.platform),
    coalesce(nullif(trim(new.sku_id), ''), 'name:' || trim(new.product_name)),
    nullif(trim(new.sku_id), ''),
    new.master_product_skuid,
    trim(new.product_name),
    new.price, new.rating, new.review_count
  )
  on conflict (snapshot_date, platform, sku_key) do update set
    -- the same SKU can appear twice in one load; never let an empty duplicate wipe real values
    product_name = excluded.product_name,
    master_product_skuid = coalesce(excluded.master_product_skuid, product_rating_review_history.master_product_skuid),
    price = coalesce(excluded.price, product_rating_review_history.price),
    rating = coalesce(excluded.rating, product_rating_review_history.rating),
    review_count = coalesce(excluded.review_count, product_rating_review_history.review_count),
    captured_at = now();
  return new;
end $$;

drop trigger if exists capture_rating_history on public.product_rating_review_metrics;
create trigger capture_rating_history
  after insert or update on public.product_rating_review_metrics
  for each row execute function public.trg_capture_rating_history();

-- Weekly upload: replaces the latest snapshot and (re)writes that date's history in one transaction.
-- p_rows: [{platform, sku_id, product_name, price, rating, review_count, master_product_skuid?}, ...]
create or replace function public.replace_product_rating_metrics(p_rows jsonb, p_snapshot_date date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'No rows to load';
  end if;
  if p_snapshot_date is null or p_snapshot_date > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'Snapshot date must be today or earlier';
  end if;

  perform set_config('app.rating_snapshot_date', p_snapshot_date::text, true);

  delete from public.product_rating_review_history where snapshot_date = p_snapshot_date;

  -- Only the newest week is "latest"; back-filling an older week leaves the current data alone.
  if p_snapshot_date >= coalesce((select max(snapshot_date) from public.product_rating_review_history), p_snapshot_date) then
    delete from public.product_rating_review_metrics where true;
    insert into public.product_rating_review_metrics
      (platform, master_product_skuid, sku_id, product_name, price, rating, review_count, created_at, updated_at)
    select trim(r->>'platform'), nullif(trim(r->>'master_product_skuid'), ''), nullif(trim(r->>'sku_id'), ''),
           trim(r->>'product_name'), nullif(r->>'price', '')::numeric, nullif(r->>'rating', '')::numeric,
           nullif(r->>'review_count', '')::numeric::int, now(), now()
    from jsonb_array_elements(p_rows) r
    where coalesce(trim(r->>'platform'), '') <> '' and coalesce(trim(r->>'product_name'), '') <> '';
  else
    -- Back-dated week: write history directly. DISTINCT ON keeps one row per SKU
    -- (the one carrying data) because a load can list the same SKU twice.
    insert into public.product_rating_review_history
      (snapshot_date, platform, sku_key, sku_id, master_product_skuid, product_name, price, rating, review_count)
    select distinct on (platform, sku_key) p_snapshot_date, platform, sku_key, sku_id, master_product_skuid,
           product_name, price, rating, review_count
    from (
      select trim(r->>'platform') platform,
             coalesce(nullif(trim(r->>'sku_id'), ''), 'name:' || trim(r->>'product_name')) sku_key,
             nullif(trim(r->>'sku_id'), '') sku_id, nullif(trim(r->>'master_product_skuid'), '') master_product_skuid,
             trim(r->>'product_name') product_name, nullif(r->>'price', '')::numeric price,
             nullif(r->>'rating', '')::numeric rating, nullif(r->>'review_count', '')::numeric::int review_count, n
      from jsonb_array_elements(p_rows) with ordinality as x(r, n)
      where coalesce(trim(r->>'platform'), '') <> '' and coalesce(trim(r->>'product_name'), '') <> ''
    ) t
    order by platform, sku_key, (rating is not null or review_count is not null or price is not null) desc, n desc;
  end if;

  select count(*) into v_count from public.product_rating_review_history where snapshot_date = p_snapshot_date;
  return jsonb_build_object('snapshot_date', p_snapshot_date, 'rows', v_count);
end $$;

revoke all on function public.replace_product_rating_metrics(jsonb, date) from public;
grant execute on function public.replace_product_rating_metrics(jsonb, date) to anon, authenticated;

-- One row per snapshot per platform, for the weekly trend chart.
create or replace view public.product_rating_review_weekly with (security_invoker = true) as
select snapshot_date, platform,
       count(*) as sku_count,
       count(*) filter (where rating > 0) as rated_count,
       round(avg(rating) filter (where rating > 0), 2) as avg_rating,
       count(*) filter (where rating > 0 and rating < 4) as below_4,
       count(*) filter (where rating > 0 and rating < 3) as below_3
from public.product_rating_review_history
where lower(platform) not in ('deleted', 'old', 'sku changed', 'no sku', 'unknown')
group by snapshot_date, platform;

grant select on public.product_rating_review_weekly to anon, authenticated;

-- Back-fill: the data already in the table becomes its first snapshot.
select set_config('app.rating_snapshot_date', (select (min(created_at) at time zone 'Asia/Kolkata')::date::text
                                               from public.product_rating_review_metrics), true);
insert into public.product_rating_review_history
  (snapshot_date, platform, sku_key, sku_id, master_product_skuid, product_name, price, rating, review_count, captured_at)
select distinct on (trim(platform), coalesce(nullif(trim(sku_id), ''), 'name:' || trim(product_name)))
       public.product_rating_snapshot_date(), trim(platform),
       coalesce(nullif(trim(sku_id), ''), 'name:' || trim(product_name)),
       nullif(trim(sku_id), ''), master_product_skuid, trim(product_name), price, rating, review_count, created_at
from public.product_rating_review_metrics
order by trim(platform), coalesce(nullif(trim(sku_id), ''), 'name:' || trim(product_name)),
         (rating is not null or review_count is not null or price is not null) desc, id desc
on conflict (snapshot_date, platform, sku_key) do nothing;
