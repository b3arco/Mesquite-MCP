create extension if not exists pgcrypto;

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  name text,
  company text,
  email text,
  phone text,
  website text,
  source text,
  service text,
  status text not null default 'new',
  tags text[] not null default '{}',
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists lead_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  event_type text not null,
  body text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists followup_tasks (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  title text not null,
  status text not null default 'open',
  channel text,
  due_at timestamptz,
  details text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
