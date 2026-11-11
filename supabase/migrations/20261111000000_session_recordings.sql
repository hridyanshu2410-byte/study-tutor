-- Session recordings for the DIS study: one folder per tester and session in a
-- private storage bucket. A folder holds session.json (every stroke, phrase,
-- trigger, model call and interruption on one clock) and, when voice
-- recording is on, the voice files (student.webm, human_tutor.webm).
-- Voice identifies people, so it lives only here, never in the events table.
-- Testers can write only into their own folder and cannot read anything back;
-- researchers read through the server with the service role (/replay).

insert into storage.buckets (id, name, public)
values ('recordings', 'recordings', false)
on conflict (id) do update set public = false;

create policy "testers upload their own recordings"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);

-- Saving again during a session replaces the file (upsert needs update too).
create policy "testers update their own recordings"
  on storage.objects for update to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);

-- Upsert checks for an existing file first, so testers may see their own
-- file names (not other testers').
create policy "testers see their own recording names"
  on storage.objects for select to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);

-- Ratings after each block of a solo session.
alter table public.events drop constraint events_kind_check;
alter table public.events add constraint events_kind_check check (
  kind in ('tutor_turn', 'card_created', 'review_graded', 'deck_imported', 'feedback', 'review_started', 'session_finished', 'survey', 'test', 'photo_added', 'sim_watched', 'paper_opened', 'block_survey')
);
