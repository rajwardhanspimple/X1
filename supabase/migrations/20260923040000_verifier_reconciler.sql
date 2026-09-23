-- RE:Arena verifier reconciler (WO-38).
--
-- The verifier chains itself: each slice posts to the function for the next one. If that post fails (a cold-start
-- timeout, a platform hiccup), nothing else would ever pick the job up and the run would stay pending forever. This
-- migration adds the JobReconciler the Run Verification blueprint calls for: a pg_cron job that looks for stalled work
-- once a minute and either restarts it or settles it.

-- ---------------------------------------------------------------------------
-- verifier_config: where the reconciler sends its kick
-- ---------------------------------------------------------------------------
--
-- One row. Holds the function URL and the webhook secret, because pg_net needs both and a migration must not contain a
-- secret. RLS is on with no policies, so only service_role and security-definer functions can read it.
create table if not exists public.verifier_config (
  id             boolean primary key default true check (id),
  function_url   text not null check (function_url ~ '^https://'),
  webhook_secret text not null check (length(webhook_secret) >= 16),
  updated_at     timestamptz not null default now()
);

comment on table public.verifier_config is
  'Single row: the verify-run function URL and webhook secret, for the pg_cron reconciler. Service role only.';

alter table public.verifier_config enable row level security;
revoke all on public.verifier_config from anon, authenticated;
grant all on public.verifier_config to service_role;

-- ---------------------------------------------------------------------------
-- reconcile_verification_jobs: settle or restart stalled jobs
-- ---------------------------------------------------------------------------
--
-- Two cases.
--
-- Exhausted: the job used its whole slice budget and the run is still pending. The verifier rejects in this case when it
-- sees it, but only if an invocation reaches that check. Rejecting here as verifier_error means the player always gets an
-- outcome instead of a run that is pending forever.
--
-- Idle: the job is claimable and has not been touched for over a minute. The minute matters: a job enqueued seconds ago
-- has a chain call or webhook in flight, and kicking it too would double the CPU spent on it. One kick per pass is enough,
-- because the function claims one job and chains through the rest of its slices itself.
create or replace function public.reconcile_verification_jobs()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job       record;
  v_exhausted integer := 0;
  v_idle      integer := 0;
  v_url       text;
  v_secret    text;
  v_kicked    boolean := false;
begin
  for v_job in
    select j.run_id
      from public.verification_jobs j
      join public.runs r on r.id = j.run_id
     where j.slices_done >= j.max_slices
       and r.status = 'pending'
  loop
    perform public.reject_run(v_job.run_id, 'verifier_error', null);
    v_exhausted := v_exhausted + 1;
  end loop;

  select count(*) into v_idle
    from public.verification_jobs j
    join public.runs r on r.id = j.run_id
   where (j.claimed_until is null or j.claimed_until < now())
     and j.slices_done < j.max_slices
     and r.status = 'pending'
     and j.updated_at < now() - interval '1 minute';

  if v_idle > 0 then
    select function_url, webhook_secret into v_url, v_secret
      from public.verifier_config
     where id;

    if v_url is not null then
      -- An empty body: the function goes straight to claim_verification_job.
      perform net.http_post(
        url                  := v_url,
        body                 := '{}'::jsonb,
        headers              := jsonb_build_object(
                                  'content-type', 'application/json',
                                  'x-verifier-secret', v_secret),
        timeout_milliseconds := 5000
      );
      v_kicked := true;
    end if;
  end if;

  return jsonb_build_object('exhausted', v_exhausted, 'idle', v_idle, 'kicked', v_kicked);
end $$;

revoke all on function public.reconcile_verification_jobs() from public;
revoke all on function public.reconcile_verification_jobs() from anon, authenticated;
grant execute on function public.reconcile_verification_jobs() to service_role;

-- Every minute. Scheduling under a fixed name replaces any earlier schedule, so re-running this migration is safe.
select cron.schedule(
  'rearena-verifier-reconcile',
  '* * * * *',
  $$select public.reconcile_verification_jobs()$$
);
