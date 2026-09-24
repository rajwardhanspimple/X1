-- RE:Arena: start verification when a run is inserted (WO-38).
--
-- This replaces the Database Webhook the go-live steps used to ask for. Creating that webhook from the dashboard needs the
-- supabase_functions schema, which only exists on projects where webhooks have been enabled, and on this project it did
-- not. A trigger calling pg_net directly does the same job, lives in a migration, and reads its target and secret from
-- verifier_config, which the reconciler already uses.
--
-- Order matters. The job is enqueued BEFORE the HTTP call, so a failed or missing call still leaves a job the reconciler
-- will find and start within a minute. The call only makes the common case fast.

create or replace function public.start_run_verification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text;
  v_secret text;
begin
  perform public.enqueue_verification(new.id);

  select function_url, webhook_secret into v_url, v_secret
    from public.verifier_config
   where id;

  if v_url is not null then
    /*
     * Never let the kick fail the insert. A player's run must be saved even if pg_net is unavailable for a moment; the
     * job is already queued, so the reconciler covers this case.
     */
    begin
      perform net.http_post(
        url                  := v_url,
        body                 := jsonb_build_object('record', jsonb_build_object('id', new.id)),
        headers              := jsonb_build_object(
                                  'content-type', 'application/json',
                                  'x-verifier-secret', v_secret),
        timeout_milliseconds := 5000
      );
    exception when others then
      null;
    end;
  end if;

  return new;
end $$;

revoke all on function public.start_run_verification() from public;
revoke all on function public.start_run_verification() from anon, authenticated;

drop trigger if exists runs_start_verification on public.runs;
create trigger runs_start_verification
  after insert on public.runs
  for each row execute function public.start_run_verification();
