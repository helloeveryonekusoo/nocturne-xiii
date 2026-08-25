create extension if not exists pgcrypto;

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code char(4) not null unique check (code ~ '^[0-9]{4}$'),
  host_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'lobby' check (status in ('lobby', 'playing', 'finished')),
  max_players smallint not null default 5 check (max_players between 2 and 5),
  card_counts jsonb not null,
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);

create table public.room_players (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  player_id text not null,
  display_name text not null check (char_length(display_name) between 1 and 16),
  seat smallint not null check (seat between 0 and 4),
  connected boolean not null default true,
  last_seen_at timestamptz not null default now(),
  primary key (room_id, user_id),
  unique (room_id, seat),
  unique (room_id, player_id)
);

create table public.game_states (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  state jsonb not null,
  version bigint not null,
  updated_at timestamptz not null default now()
);

create table public.command_receipts (
  room_id uuid not null references public.rooms(id) on delete cascade,
  command_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  resulting_version bigint not null,
  created_at timestamptz not null default now(),
  primary key (room_id, command_id)
);

create index rooms_expires_idx on public.rooms(expires_at);
create index room_players_user_idx on public.room_players(user_id, room_id);
create index command_receipts_created_idx on public.command_receipts(created_at);

alter table public.rooms enable row level security;
alter table public.room_players enable row level security;
alter table public.game_states enable row level security;
alter table public.command_receipts enable row level security;

revoke all on public.game_states from anon, authenticated;
revoke all on public.command_receipts from anon, authenticated;
grant select on public.rooms, public.room_players to authenticated;

create or replace function public.is_room_member(target_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.room_players
    where room_id = target_room_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_room_topic_member(target_topic text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.room_players rp
    join public.rooms r on r.id = rp.room_id
    where rp.user_id = auth.uid() and target_topic = 'room:' || r.code
  );
$$;

grant execute on function public.is_room_member(uuid) to authenticated;
grant execute on function public.is_room_topic_member(text) to authenticated;

create policy "room members can read room metadata"
on public.rooms for select to authenticated
using (public.is_room_member(rooms.id));

create policy "room members can read the roster"
on public.room_players for select to authenticated
using (public.is_room_member(room_players.room_id));

create policy "members can receive private room broadcasts"
on realtime.messages for select to authenticated
using (
  realtime.topic() like 'room:%' and public.is_room_topic_member(realtime.topic())
);

create policy "members can send private room broadcasts"
on realtime.messages for insert to authenticated
with check (
  realtime.topic() like 'room:%' and public.is_room_topic_member(realtime.topic())
);

comment on table public.game_states is 'Authoritative state. Service role only; never exposed through PostgREST.';
comment on column public.rooms.code is 'Human-friendly locator, not an authorization credential.';
