-- Removes the atomic-upload objects. The dashboard then uses its previous upload path again.
-- Safe at any time: neither object holds data that exists nowhere else (staging rows are copies of
-- a file still being uploaded).
drop function if exists public.barm_commit_staged_upload(uuid, text, jsonb, integer, text);
drop table if exists public.barm_upload_staging;
