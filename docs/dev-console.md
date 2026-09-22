  const host = new SimulationHost({
    onCheckpoint(checkpoint: StateCheckpoint) {
      recorder.appendCheckpoint(checkpoint);
    },
    onEnded(summary: RunSummary, runTainted: boolean) {
      const log = recorder.finish(summary);
      console.info('[rearena] round ended', summary, log ? `${log.frames.length} frames` : 'no log');
      /*
       * A tainted run is discarded rather than kept. Its checkpoint hashes no longer match a clean
       * replay of the same inputs, so the verifier would reject it; dropping it here means the
       * client never wastes a submission and the player is told why.
       */
      if (runTainted) recorder.discard();
      orchestrator.finish(summary);
      if (runTainted) {
        screens.setVerification(
          'Developer overrides were used, so this run was not recorded. Start a new round for a submittable score.',
        );
      }
    },
    onError(message) {
      console.error('[rearena] simulation error', message);
      screens.setError(`Simulation failed. ${message}`);
      orchestrator.dispatch('quit');
    },
  });

  /*
   * Developer console, dev builds only. Stripped from production by dead-code elimination on
   * import.meta.env.DEV rather than merely hidden.
   */
  const removeDevApi = installDevApi({
    setDebugFlags(flags) {
      host.sendDebugFlags(flags);
    },
    runDebugAction(action) {
      host.sendDebugAction(action);
    },
    currentFlags() {
      return host.currentDebugFlags();
    },
    isTainted() {
      return host.isTainted();
    },
    snapshotSummary() {
      return host.debugSnapshot();
    },
  });
