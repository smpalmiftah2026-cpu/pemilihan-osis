-- ============================================================
-- SISTEM PEMILIHAN OSIS SMP/SMA AL-MIFTAH - SUPABASE SETUP
-- Jalankan seluruh file ini di Supabase > SQL Editor > New query.
-- ============================================================

create extension if not exists pgcrypto;

-- 1) Profil pengguna aplikasi (akun sebenarnya dibuat di Supabase Auth)
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null check (role in ('admin','operator')),
  created_at timestamptz not null default now()
);

-- 2) Pemilihan terpisah SMP dan SMA
create table if not exists public.elections (
  id uuid primary key default gen_random_uuid(),
  unit text not null unique check (unit in ('SMP','SMA')),
  school_name text not null default 'AL-MIFTAH',
  title text not null default 'Pemilihan Ketua dan Wakil Ketua OSIS',
  period text not null default '2026/2027',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 3) Kandidat
create table if not exists public.candidates (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references public.elections(id) on delete cascade,
  ballot_code text not null check (char_length(ballot_code) <= 4),
  chair_name text not null,
  vice_name text not null,
  vision text not null default '',
  photo_url text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (election_id, ballot_code)
);

-- 4) Siswa
create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references public.elections(id) on delete cascade,
  nisn text not null,
  name text not null,
  class_name text not null,
  called_at timestamptz,
  voted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (election_id, nisn)
);
create index if not exists students_election_class_idx on public.students(election_id,class_name);

-- 5) Kartu RFID khusus untuk pilihan A/B
create table if not exists public.vote_cards (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references public.elections(id) on delete cascade,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  tag_uid text not null,
  created_at timestamptz not null default now(),
  unique (election_id, candidate_id),
  unique (election_id, tag_uid)
);

-- 6) Suara. Constraint UNIQUE memastikan satu siswa hanya bisa memilih sekali.
create table if not exists public.votes (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references public.elections(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete restrict,
  candidate_id uuid not null references public.candidates(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (election_id, student_id)
);
create index if not exists votes_election_candidate_idx on public.votes(election_id,candidate_id);

-- Data awal pemilihan
insert into public.elections(unit,school_name,title,period,is_active)
values
('SMP','SMP AL-MIFTAH','Pemilihan Ketua dan Wakil Ketua OSIS','2026/2027',true),
('SMA','SMA AL-MIFTAH','Pemilihan Ketua dan Wakil Ketua OSIS','2026/2027',true)
on conflict (unit) do update set is_active=excluded.is_active;

-- ============================================================
-- HELPER ROLE
-- ============================================================
create or replace function public.app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.role from public.profiles p where p.user_id = auth.uid();
$$;

revoke all on function public.app_role() from public, anon;
grant execute on function public.app_role() to authenticated;

-- ============================================================
-- RPC: REKAM SUARA SECARA ATOMIK
-- - hanya admin/operator login
-- - UID kartu dipetakan di database, bukan di kode GitHub
-- - lock baris siswa mencegah dua request bersamaan
-- - unique(election_id,student_id) menjadi lapisan perlindungan kedua
-- ============================================================
create or replace function public.submit_vote(p_student_id uuid, p_tag_uid text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student public.students%rowtype;
  v_card public.vote_cards%rowtype;
  v_candidate public.candidates%rowtype;
  v_role text;
begin
  select p.role into v_role from public.profiles p where p.user_id = auth.uid();
  if v_role not in ('admin','operator') then
    raise exception 'Akun tidak memiliki izin pemilihan';
  end if;

  select * into v_student
  from public.students
  where id = p_student_id
  for update;

  if not found then raise exception 'Data siswa tidak ditemukan'; end if;
  if v_student.voted_at is not null then raise exception 'Siswa ini sudah memilih'; end if;

  if not exists(select 1 from public.elections e where e.id=v_student.election_id and e.is_active=true) then
    raise exception 'Pemilihan tidak aktif';
  end if;

  select * into v_card
  from public.vote_cards vc
  where vc.election_id=v_student.election_id and vc.tag_uid=trim(p_tag_uid);

  if not found then raise exception 'Kartu RFID tidak dikenali'; end if;

  select * into v_candidate from public.candidates c
  where c.id=v_card.candidate_id and c.election_id=v_student.election_id and c.active=true;
  if not found then raise exception 'Kandidat tidak aktif'; end if;

  insert into public.votes(election_id,student_id,candidate_id,created_by)
  values(v_student.election_id,v_student.id,v_candidate.id,auth.uid());

  update public.students set voted_at=now() where id=v_student.id;

  return jsonb_build_object('ok',true,'candidate_id',v_candidate.id,'ballot_code',v_candidate.ballot_code);
exception
  when unique_violation then
    raise exception 'Siswa ini sudah memilih';
end;
$$;

revoke all on function public.submit_vote(uuid,text) from public, anon;
grant execute on function public.submit_vote(uuid,text) to authenticated;


-- RPC: simpan waktu panggilan tanpa memberi operator hak UPDATE bebas ke tabel students.
create or replace function public.mark_student_called(p_student_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  select p.role into v_role from public.profiles p where p.user_id = auth.uid();
  if v_role not in ('admin','operator') then
    raise exception 'Akun tidak memiliki izin pemanggilan';
  end if;

  update public.students set called_at=now() where id=p_student_id;
  if not found then raise exception 'Data siswa tidak ditemukan'; end if;
  return true;
end;
$$;

revoke all on function public.mark_student_called(uuid) from public, anon;
grant execute on function public.mark_student_called(uuid) to authenticated;

-- ============================================================
-- RLS + GRANTS
-- ============================================================
alter table public.profiles enable row level security;
alter table public.elections enable row level security;
alter table public.candidates enable row level security;
alter table public.students enable row level security;
alter table public.vote_cards enable row level security;
alter table public.votes enable row level security;

revoke all on table public.profiles,public.elections,public.candidates,public.students,public.vote_cards,public.votes from anon, authenticated;

grant select on public.profiles to authenticated;
grant select on public.elections to authenticated;
grant select,insert,update on public.candidates to authenticated;
grant select,insert,update,delete on public.students to authenticated;
grant select,insert,update,delete on public.vote_cards to authenticated;
grant select on public.votes to authenticated;

-- Profiles
create policy "profile read own" on public.profiles for select to authenticated using (user_id = (select auth.uid()));

-- Elections
create policy "elections read" on public.elections for select to authenticated using (true);

-- Candidates
create policy "candidates read" on public.candidates for select to authenticated using (true);
create policy "candidates admin insert" on public.candidates for insert to authenticated with check ((select public.app_role())='admin');
create policy "candidates admin update" on public.candidates for update to authenticated using ((select public.app_role())='admin') with check ((select public.app_role())='admin');

-- Students: admin dapat import/ubah; operator hanya baca. Pemanggilan operator lewat RPC mark_student_called().
create policy "students read" on public.students for select to authenticated using ((select public.app_role()) in ('admin','operator'));
create policy "students admin insert" on public.students for insert to authenticated with check ((select public.app_role())='admin');
create policy "students admin update" on public.students for update to authenticated using ((select public.app_role())='admin') with check ((select public.app_role())='admin');
create policy "students admin delete" on public.students for delete to authenticated using ((select public.app_role())='admin');

-- Kartu RFID hanya admin yang dapat melihat/mengatur.
create policy "vote cards admin read" on public.vote_cards for select to authenticated using ((select public.app_role())='admin');
create policy "vote cards admin insert" on public.vote_cards for insert to authenticated with check ((select public.app_role())='admin');
create policy "vote cards admin update" on public.vote_cards for update to authenticated using ((select public.app_role())='admin') with check ((select public.app_role())='admin');
create policy "vote cards admin delete" on public.vote_cards for delete to authenticated using ((select public.app_role())='admin');

-- Votes hanya bisa dibuat melalui RPC submit_vote. Admin/operator boleh melihat hasil.
create policy "votes read" on public.votes for select to authenticated using ((select public.app_role()) in ('admin','operator'));

-- ============================================================
-- STORAGE POLICY (buat bucket candidate-photos dari Dashboard terlebih dahulu)
-- Bucket disarankan PUBLIC karena foto kandidat memang ditampilkan ke aplikasi.
-- ============================================================
create policy "candidate photo admin upload"
on storage.objects for insert to authenticated
with check (bucket_id = 'candidate-photos' and (select public.app_role())='admin');

create policy "candidate photo admin update"
on storage.objects for update to authenticated
using (bucket_id = 'candidate-photos' and (select public.app_role())='admin')
with check (bucket_id = 'candidate-photos' and (select public.app_role())='admin');

create policy "candidate photo admin delete"
on storage.objects for delete to authenticated
using (bucket_id = 'candidate-photos' and (select public.app_role())='admin');

-- ============================================================
-- SETELAH MEMBUAT USER DI AUTH:
-- Ganti UUID di bawah lalu jalankan satu baris INSERT secara terpisah.
-- Contoh:
-- insert into public.profiles(user_id,full_name,role)
-- values ('UUID_DARI_AUTH_USERS','Administrator','admin');
--
-- Akun operator bilik:
-- insert into public.profiles(user_id,full_name,role)
-- values ('UUID_OPERATOR','Operator Bilik','operator');
-- ============================================================
