-- Atomic uploads (PROPOSED — not applied; apply only after approval).
--
-- Problem: most uploads delete the rows they are about to replace and then insert the new file in
-- 300-row requests from the browser. If a request fails part-way, the table is left with the old
-- rows gone and only some of the new ones in.
--
-- Fix: the browser first writes the whole file into a staging table (production untouched), then
-- makes ONE call to barm_commit_staged_upload. That function deletes and inserts inside a single
-- database transaction, so the swap either happens completely or not at all.
--
-- Additive only: one new table, one new function. No existing table, row, policy or function is
-- changed. The dashboard code falls back to the old path while this is not installed.
--
-- Rollback: see 99_rollback.sql.

create table if not exists public.barm_upload_staging (
  session_id   uuid        not null,
  batch_index  integer     not null,
  target_table text        not null,
  rows         jsonb       not null,
  created_at   timestamptz not null default now(),
  primary key (session_id, batch_index)
);
comment on table public.barm_upload_staging is
  'Holding area for a file being uploaded. Rows are moved into the target table by barm_commit_staged_upload in one transaction and removed. Anything older than a day is an abandoned upload.';
create index if not exists barm_upload_staging_created_at_idx on public.barm_upload_staging (created_at);

-- p_delete (what the new rows replace), one of:
--   {"kind":"all"}
--   {"kind":"none"}
--   {"kind":"range","column":"report_date","gte":"2026-11-01","lte":"2026-11-07"}
--   {"kind":"range","column":"purchase_datetime","gte":"2026-11-01T00:00:00Z","lt":"2026-11-08T00:00:00Z"}
--   {"kind":"in","column":"report_date","values":["2026-11-01","2026-11-02"]}
-- p_on_conflict: comma-separated key columns for "insert, or update the row with the same key".
-- Returns the number of rows written.
create or replace function public.barm_commit_staged_upload(
  p_session       uuid,
  p_table         text,
  p_delete        jsonb,
  p_expected_rows integer,
  p_on_conflict   text default null
) returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  -- Only the dashboard's own upload tables. Nothing belonging to another B-ARM application.
  allowed constant text[] := array[
    'barm_amazon_am_orders','barm_amazon_am_returns','barm_amazon_fba_returns','barm_amazon_sf_return',
    'barm_amazon_fba_inventory','barm_amazon_inventory_ledger','barm_amazon_price_listing',
    'barm_amazon_sp_advertised_product','barm_amazon_sb_campaign','barm_amazon_sd_campaign',
    'barm_daily_am_ads','barm_daily_am_orders','barm_daily_fk_ads','barm_daily_fk_orders',
    'barm_daily_ms_barm_ads','barm_daily_ms_barm_orders','barm_daily_ms_mw_ads','barm_daily_ms_mw_orders',
    'barm_flipkart_campaign_performance','barm_flipkart_earn_more','barm_flipkart_fsn_report',
    'barm_flipkart_listings','barm_flipkart_order_report','barm_flipkart_overall_sales','barm_flipkart_returns',
    'barm_product_master','master_product_marketing'
  ];
  v_staged    integer;
  v_cols      text;
  v_conflict  text := '';
  v_where     text;
  v_kind      text := coalesce(p_delete->>'kind', '');
  v_col       text := p_delete->>'column';
  v_written   integer;
  v_key       text;
  v_keys      text[];
begin
  if p_table is null or not (p_table = any(allowed)) then
    raise exception 'barm_commit_staged_upload: table "%" is not an upload target', p_table;
  end if;
  if to_regclass('public.' || quote_ident(p_table)) is null then
    raise exception 'barm_commit_staged_upload: table "%" does not exist', p_table;
  end if;

  -- Everything staged for this session must be for this table, and must all have arrived.
  select coalesce(sum(jsonb_array_length(s.rows)), 0)::int into v_staged
    from barm_upload_staging s where s.session_id = p_session and s.target_table = p_table;
  if v_staged = 0 then
    raise exception 'barm_commit_staged_upload: nothing is staged for this upload';
  end if;
  if v_staged <> p_expected_rows then
    raise exception 'barm_commit_staged_upload: % rows staged, % expected — upload incomplete, nothing changed', v_staged, p_expected_rows;
  end if;

  -- Columns to write: the keys the file's rows carry that are real columns of the target. Columns
  -- the rows do not mention (id, created_at …) keep their defaults.
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position) into v_cols
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = p_table
     and c.column_name in (
       select distinct k from barm_upload_staging s, jsonb_array_elements(s.rows) r, jsonb_object_keys(r) k
        where s.session_id = p_session and s.target_table = p_table);
  if v_cols is null then
    raise exception 'barm_commit_staged_upload: the staged rows share no column with "%"', p_table;
  end if;

  -- What gets replaced. Column names are checked against the table; values are quoted literals.
  if v_kind in ('range', 'in') then
    if v_col is null or not exists (select 1 from information_schema.columns
        where table_schema = 'public' and table_name = p_table and column_name = v_col) then
      raise exception 'barm_commit_staged_upload: "%" is not a column of "%"', v_col, p_table;
    end if;
  end if;
  if v_kind = 'all' then
    v_where := 'true';
  elsif v_kind = 'none' then
    v_where := null;
  elsif v_kind = 'range' then
    if p_delete->>'gte' is null or (p_delete->>'lte' is null and p_delete->>'lt' is null) then
      raise exception 'barm_commit_staged_upload: a range needs "gte" and "lte" or "lt"';
    end if;
    v_where := format('%I >= %L and ', v_col, p_delete->>'gte') ||
      case when p_delete->>'lt' is not null then format('%I < %L', v_col, p_delete->>'lt')
           else format('%I <= %L', v_col, p_delete->>'lte') end;
  elsif v_kind = 'in' then
    if jsonb_typeof(p_delete->'values') <> 'array' or jsonb_array_length(p_delete->'values') = 0 then
      raise exception 'barm_commit_staged_upload: "in" needs a non-empty "values" array';
    end if;
    v_where := format('%I::text = any (%L::text[])', v_col,
      (select array_agg(v) from jsonb_array_elements_text(p_delete->'values') v));
  else
    raise exception 'barm_commit_staged_upload: unknown delete kind "%"', v_kind;
  end if;

  if p_on_conflict is not null and btrim(p_on_conflict) <> '' then
    v_keys := string_to_array(replace(p_on_conflict, ' ', ''), ',');
    foreach v_key in array v_keys loop
      if not exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = p_table and column_name = v_key) then
        raise exception 'barm_commit_staged_upload: conflict key "%" is not a column of "%"', v_key, p_table;
      end if;
    end loop;
    select format(' on conflict (%s) do update set %s',
             (select string_agg(quote_ident(k), ', ') from unnest(v_keys) k),
             string_agg(format('%1$s = excluded.%1$s', col), ', '))
      into v_conflict
      from unnest(string_to_array(v_cols, ', ')) col
     where col <> all (select quote_ident(k) from unnest(v_keys) k);
    -- Rows that carry nothing but the key columns have nothing to update.
    v_conflict := coalesce(v_conflict, format(' on conflict (%s) do nothing',
      (select string_agg(quote_ident(k), ', ') from unnest(v_keys) k)));
  end if;

  -- The swap. Both statements are inside this function's transaction: if the insert fails, the
  -- delete is undone with it.
  if v_where is not null then
    execute format('delete from public.%I where %s', p_table, v_where);
  end if;
  execute format(
    'insert into public.%1$I (%2$s) select %2$s from barm_upload_staging s, jsonb_populate_recordset(null::public.%1$I, s.rows) where s.session_id = %3$L and s.target_table = %1$L order by s.batch_index%4$s',
    p_table, v_cols, p_session, v_conflict);
  get diagnostics v_written = row_count;

  delete from barm_upload_staging where session_id = p_session;
  -- Abandoned uploads (a browser closed mid-file) are cleared a day later.
  delete from barm_upload_staging where created_at < now() - interval '1 day';
  return v_written;
end;
$$;

comment on function public.barm_commit_staged_upload(uuid, text, jsonb, integer, text) is
  'Moves one staged upload into its target table in a single transaction (delete what it replaces, insert the new rows). All or nothing.';

-- Same access as the upload tables themselves have today (the dashboard writes with the anon key).
grant select, insert, delete on public.barm_upload_staging to anon, authenticated;
grant execute on function public.barm_commit_staged_upload(uuid, text, jsonb, integer, text) to anon, authenticated;
