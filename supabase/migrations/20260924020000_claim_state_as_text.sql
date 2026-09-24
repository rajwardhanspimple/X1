-- RE:Arena: return the saved slice state as text (WO-38).
--
-- verification_jobs.state is bytea. The verifier writes the serialised SimState as a base64 string, which PostgREST stores
-- as that string's bytes. claim_verification_job returned the column as bytea, and PostgREST serialises bytea as
-- '\x<hex>', so the verifier's fromBase64 failed with "Failed to decode base64" on every second slice. Slice 1 always
-- worked, because it starts with no state, which is why this hid until the first real three-minute run.
--
-- The fix is in the read, not the column: convert_from gives back exactly the base64 text the verifier wrote. The column
-- stays bytea, so rows already saved need no migration.
--
-- The return type changes from bytea to text, and Postgres cannot change a function's return type in place, hence the
-- drop.

drop function if exists public.claim_verification_job(integer);

create function public.claim_verification_job(p_lease_seconds integer default 30)
returns table (
  job_id uuid,
  run_id uuid,
  cursor_tick integer,
  state text,
  resume_hash text,
  slices_done integer,
  max_slices integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.verification_jobs j
     set claimed_until = now() + make_interval(secs => p_lease_seconds),
         attempts = j.attempts + 1
   where j.id = (
     select c.id
     from public.verification_jobs c
     join public.runs r on r.id = c.run_id
     where (c.claimed_until is null or c.claimed_until < now())
       and c.slices_done < c.max_slices
       and r.status = 'pending'
     order by c.created_at
     limit 1
     -- Skips rows another transaction holds rather than waiting on them, so concurrent claims do not serialise.
     for update of c skip locked
   )
  returning j.id, j.run_id, j.cursor_tick, convert_from(j.state, 'UTF8'), j.resume_hash, j.slices_done, j.max_slices;
end $$;

revoke all on function public.claim_verification_job(integer) from public;
revoke all on function public.claim_verification_job(integer) from anon, authenticated;
grant execute on function public.claim_verification_job(integer) to service_role;
