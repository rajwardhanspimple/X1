/**
 * Verification mount: carry a finished run from the Result Screen to its verdict (WO-40).
 *
 * Owns the Result Screen's status line once a round ends. It submits the run through the sync mount's queue, so a
 * failed submission is kept on the device and retried, then follows the server's verdict with RunStatusTracker.
 *
 * Self-contained for the same reason as the account and sync mounts: main.ts hands it a finished log and nothing else,
 * and none of this touches the round lifecycle beyond being told to stop when a new round starts.
 *
 * A verified verdict is also announced as RUN_VERIFIED_EVENT, so the leaderboard can drop pages that no longer include
 * the new entry without the two modules knowing about each other.
 */

import '../results.css';
import type { RunLog } from '@rearena/protocol';
import type { Screens, VerificationView } from '../hud/screens.js';
import { RunStatusTracker, type RunStatusView } from '../net/run-status.js';
import { isBackendConfigured } from '../net/supabase.js';
import type { SyncMount } from './sync-mount.js';

/** Dispatched on window when a run this client submitted is verified. */
export const RUN_VERIFIED_EVENT = 'rearena:run-verified';

export interface VerificationMount {
  /** Submit a finished run and follow it to a verdict on the Result Screen. */
  track(log: RunLog): void;
  /** Stop following. Called when a new round starts, so an old verdict cannot land on a new screen. */
  stop(): void;
  dispose(): void;
}

/** Words for each server-side state. The rank is the player's best, which is what the board shows for them. */
function describe(view: RunStatusView): VerificationView {
  switch (view.kind) {
    case 'pending':
      return { text: 'Pending verification', tone: 'pending' };
    case 'slow':
      return {
        text: 'Still verifying. You can keep playing; the result will appear in your account.',
        tone: 'pending',
      };
    case 'deferred':
      return { text: 'Still verifying. Check Account later for the result.', tone: 'neutral' };
    case 'verified': {
      const score = view.score.toLocaleString();
      const rank =
        view.rank !== null && view.total !== null
          ? ` Your best is rank ${view.rank} of ${view.total} on the all-time board.`
          : '';
      return { text: `Verified. Score ${score}.${rank}`, tone: 'good' };
    }
    case 'rejected':
      return { text: view.reason, tone: 'bad' };
  }
}

export function mountVerification(screens: Screens, sync: SyncMount): VerificationMount {
  /** Bumped per round, so a submission that finishes after the player moved on changes nothing. */
  let generation = 0;
  const tracker = new RunStatusTracker((view) => {
    screens.setVerificationView(describe(view));
    if (view.kind === 'verified') window.dispatchEvent(new CustomEvent(RUN_VERIFIED_EVENT));
  });

  const submit = async (log: RunLog, mine: number): Promise<void> => {
    screens.setVerificationView({ text: 'Submitting your run', tone: 'pending' });
    const result = await sync.submitRun(log);
    if (mine !== generation) return;

    if (result.state === 'submitted') {
      tracker.follow(log.clientRunId);
      return;
    }

    if (result.state === 'unsaved') {
      screens.setVerificationView({
        text: 'This run could not be saved on this device, so it cannot be submitted.',
        tone: 'bad',
      });
      return;
    }

    // AC-ARM-005.6 and AC-VER-001.5: local only, with a retry that resends the same recorded run.
    screens.setVerificationView({
      text: `Local only. ${result.error}`,
      tone: 'bad',
      onRetry: () => {
        if (mine === generation) void submit(log, mine);
      },
    });
  };

  return {
    track(log) {
      tracker.stop();
      generation += 1;
      if (!isBackendConfigured()) {
        screens.setVerificationView({
          text: 'Result saved on this device. Playing offline, so it is not submitted.',
          tone: 'neutral',
        });
        return;
      }
      void submit(log, generation);
    },
    stop() {
      generation += 1;
      tracker.stop();
    },
    dispose() {
      generation += 1;
      tracker.stop();
    },
  };
}
