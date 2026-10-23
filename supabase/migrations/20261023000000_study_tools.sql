-- Study tools: session wrap-ups, post-session surveys, pre/post tests, and a
-- study condition per tester (set by the server at consent; testers can't change it).

alter table public.events drop constraint events_kind_check;
alter table public.events add constraint events_kind_check check (
  kind in ('tutor_turn', 'card_created', 'review_graded', 'deck_imported', 'feedback', 'review_started', 'session_finished', 'survey', 'test')
);

alter table public.profiles add column condition text;
