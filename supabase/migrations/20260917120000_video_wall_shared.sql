-- Shared state for several video walls (one per Mac) at the same event.
-- Each wall keeps its own SQLite for playback; these tables and the bucket
-- are the meeting point: every finished film and every in-flight prompt.

create or replace function public.wall_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create table if not exists public.wall_videos (
  id text primary key,
  origin text not null,                 -- WALL_ID of the Mac that rendered it
  creator_name text not null,
  prompt text not null default '',
  duration integer,
  storage_path text not null,           -- object path inside the bucket
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists wall_videos_updated_idx
  on public.wall_videos (updated_at);

drop trigger if exists wall_videos_touch on public.wall_videos;
create trigger wall_videos_touch
  before insert or update on public.wall_videos
  for each row execute function public.wall_touch_updated_at();

create table if not exists public.wall_submissions (
  id text primary key,
  origin text not null,                 -- WALL_ID of the Mac that owns the job
  creator_name text not null,
  prompt text not null,
  duration integer not null,
  status text not null,
  error text,
  video_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists wall_submissions_updated_idx
  on public.wall_submissions (updated_at);

drop trigger if exists wall_submissions_touch on public.wall_submissions;
create trigger wall_submissions_touch
  before insert or update on public.wall_submissions
  for each row execute function public.wall_touch_updated_at();

-- The walls talk to these tables through their local server with the
-- service role only; nothing is exposed to anon or authenticated clients.
alter table public.wall_videos enable row level security;
alter table public.wall_submissions enable row level security;
revoke all on table public.wall_videos from anon, authenticated;
revoke all on table public.wall_submissions from anon, authenticated;
grant all on table public.wall_videos to service_role;
grant all on table public.wall_submissions to service_role;

-- Private bucket for the MP4s. Walls download with the service role and
-- cache locally, so nothing needs to be public.
insert into storage.buckets (id, name, public)
values ('video-wall', 'video-wall', false)
on conflict (id) do nothing;
