create table public.cron_config (id int primary key default 1, tick_secret text not null);
revoke all on public.cron_config from public, anon, authenticated;
grant all on public.cron_config to service_role;
alter table public.cron_config enable row level security;
comment on table public.cron_config is 'Private scheduler config; no client roles have access.';