-- Research-study schema: one profile per tester, their saved page and review
-- memory, and an append-only event log for analysis. Row-level security lets
-- each tester reach only their own rows; researcher exports use the service role.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  participant_code text not null unique,
  consent_version text,
  consented_at timestamptz,
  age_confirmed boolean not null default false,
  intake jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.study_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  page jsonb,
  memory jsonb,
  updated_at timestamptz not null default now()
);

create table public.events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  session_id text,
  kind text not null check (kind in ('tutor_turn', 'card_created', 'review_graded', 'deck_imported', 'feedback', 'review_started')),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index events_user_time on public.events (user_id, created_at desc);
create index events_kind_time on public.events (kind, created_at desc);

alter table public.profiles enable row level security;
alter table public.study_state enable row level security;
alter table public.events enable row level security;

create policy "own profile" on public.profiles for select using ((select auth.uid()) = id);
create policy "update own profile" on public.profiles for update using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "own state" on public.study_state for select using ((select auth.uid()) = user_id);
create policy "insert own state" on public.study_state for insert with check ((select auth.uid()) = user_id);
create policy "update own state" on public.study_state for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Testers may add events but not read them back: tutor turns carry the
-- tutor's private diagnosis, which must not reach the browser.
create policy "log own events" on public.events for insert with check ((select auth.uid()) = user_id and kind <> 'tutor_turn');

-- Testers can't rename themselves: the participant code is what links their
-- data in exports, and it never contains their email.
revoke update on public.profiles from authenticated, anon;
grant update (consent_version, consented_at, age_confirmed, intake) on public.profiles to authenticated;

-- Every new account gets a profile with a short random participant code.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  code text;
begin
  loop
    code := 'P-' || upper(substr(translate(encode(extensions.gen_random_bytes(6), 'base64'), '+/=0O1Il', ''), 1, 5));
    exit when length(code) = 7 and not exists (select 1 from public.profiles where participant_code = code);
  end loop;
  insert into public.profiles (id, participant_code) values (new.id, code);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
