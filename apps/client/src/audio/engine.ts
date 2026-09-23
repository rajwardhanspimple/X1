/**
 * Audio engine.
 *
 * Every sound is synthesised at run time. No audio files: nothing to download, no licence to track, and
 * the timbre can vary per shot so sustained fire does not sound like one looping sample. A gunshot is a
 * short noise burst through a bandpass filter with a fast decay, layered with a low sine thump for
 * body; an impact is a shorter, brighter click; a footstep is a soft low-passed tap; a death is a
 * downward pitch sweep.
 *
 * Browsers refuse to start audio before a user gesture, so the context begins suspended and is resumed
 * by the same click that starts a round. Positional sounds go through a PannerNode, so a shot behind
 * you sounds behind you.
 *
 * Nothing here is read by the simulation. Audio cannot affect a run or its verification.
 */

export type SoundCategory = 'master' | 'effects' | 'footsteps' | 'ui';

export interface AudioSettings {
  master: number;
  effects: number;
  footsteps: number;
  ui: number;
  muted: boolean;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  master: 0.7,
  effects: 0.9,
  footsteps: 0.5,
  ui: 0.8,
  muted: false,
};

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Read the context state as a plain string.
 *
 * AudioContextState is a literal union, so TypeScript narrows it at a guard and keeps that narrowing
 * across an await: it has no way to know that `resume()` mutates the property. After `if (state ===
 * 'running') return`, the compiler is certain the value can never be 'running' again and prunes any
 * later comparison as dead code.
 *
 * The state is mutable external state whose value after an await is genuinely unknowable from the type
 * system, and reading it as a string is what says so. The comparison is then string-to-string, which is
 * exactly as safe and is not pruned.
 */
function stateOf(context: AudioContext): string {
  return context.state as string;
}

export class AudioEngine {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private readonly categoryGains = new Map<SoundCategory, GainNode>();
  private noiseBuffer: AudioBuffer | null = null;
  private settings: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS };
  private unlocked = false;

  /**
   * Create the graph. Safe to call before any gesture: the context starts suspended and produces no
   * sound until resume() succeeds.
   */
  init(): void {
    if (this.context) return;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      console.warn('[rearena] Web Audio is unavailable; running silent');
      return;
    }
    const context = new Ctor();
    this.context = context;

    this.masterGain = context.createGain();
    this.masterGain.gain.value = this.settings.master;
    this.masterGain.connect(context.destination);

    for (const category of ['effects', 'footsteps', 'ui'] as const) {
      const gain = context.createGain();
      gain.gain.value = this.settings[category];
      gain.connect(this.masterGain);
      this.categoryGains.set(category, gain);
    }

    // One second of white noise, reused by every noise-based sound with a different filter and
    // envelope. Generating it once keeps per-shot cost to a buffer source and two nodes.
    const frames = context.sampleRate;
    const buffer = context.createBuffer(1, frames, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buffer;

    context.listener.upX?.setValueAtTime(0, context.currentTime);
    context.listener.upY?.setValueAtTime(1, context.currentTime);
    context.listener.upZ?.setValueAtTime(0, context.currentTime);
  }

  /**
   * Call from a user gesture handler. Resolves true once the context is running.
   *
   * `resume()` resolving does not guarantee the context reached the running state, so the state is read
   * again afterwards rather than assumed. See stateOf above for why it is read as a string.
   */
  async unlock(): Promise<boolean> {
    this.init();
    const context = this.context;
    if (!context) return false;

    if (stateOf(context) === 'running') {
      this.unlocked = true;
      return true;
    }

    try {
      await context.resume();
    } catch {
      // Some browsers reject when called outside a gesture. Silent: the caller retries on the next one.
      return false;
    }

    this.unlocked = stateOf(context) === 'running';
    return this.unlocked;
  }

  isUnlocked(): boolean {
    return this.unlocked;
  }

  setSettings(next: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...next };
    if (!this.context || !this.masterGain) return;
    const now = this.context.currentTime;
    this.masterGain.gain.setTargetAtTime(this.settings.muted ? 0 : this.settings.master, now, 0.02);
    for (const [category, gain] of this.categoryGains) {
      gain.gain.setTargetAtTime(this.settings[category], now, 0.02);
    }
  }

  getSettings(): AudioSettings {
    return { ...this.settings };
  }

  toggleMute(): boolean {
    this.setSettings({ muted: !this.settings.muted });
    return this.settings.muted;
  }

  /** Move the listener to the camera. Called once per frame with the view transform. */
  setListener(position: Vec3, forward: Vec3): void {
    const context = this.context;
    if (!context) return;
    const listener = context.listener;
    const now = context.currentTime;
    if (listener.positionX) {
      listener.positionX.setValueAtTime(position.x, now);
      listener.positionY.setValueAtTime(position.y, now);
      listener.positionZ.setValueAtTime(position.z, now);
      listener.forwardX.setValueAtTime(forward.x, now);
      listener.forwardY.setValueAtTime(forward.y, now);
      listener.forwardZ.setValueAtTime(forward.z, now);
    } else {
      // Deprecated API, still needed by older Safari.
      const legacy = listener as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(
          fx: number,
          fy: number,
          fz: number,
          ux: number,
          uy: number,
          uz: number,
        ): void;
      };
      legacy.setPosition(position.x, position.y, position.z);
      legacy.setOrientation(forward.x, forward.y, forward.z, 0, 1, 0);
    }
  }

  private destination(category: SoundCategory, position?: Vec3): AudioNode | null {
    const context = this.context;
    if (!context) return null;
    const gain = this.categoryGains.get(category) ?? this.masterGain;
    if (!gain) return null;
    if (!position) return gain;

    const panner = context.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 4;
    panner.maxDistance = 90;
    panner.rolloffFactor = 1.1;
    panner.positionX.value = position.x;
    panner.positionY.value = position.y;
    panner.positionZ.value = position.z;
    panner.connect(gain);
    return panner;
  }

  /** Noise burst through a bandpass. The building block for gunfire, impacts and mechanics. */
  private noiseBurst(options: {
    category: SoundCategory;
    duration: number;
    frequency: number;
    q: number;
    gain: number;
    position?: Vec3;
    /** Sweep the filter down over the burst, which reads as a tail. */
    sweepTo?: number;
  }): void {
    const context = this.context;
    if (!context || !this.noiseBuffer || !this.unlocked) return;
    const target = this.destination(options.category, options.position);
    if (!target) return;

    const now = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;
    const offset = Math.random() * (this.noiseBuffer.duration - options.duration - 0.01);

    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = options.frequency;
    filter.Q.value = options.q;
    if (options.sweepTo !== undefined) {
      filter.frequency.setValueAtTime(options.frequency, now);
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(60, options.sweepTo),
        now + options.duration,
      );
    }

    const envelope = context.createGain();
    // Near-instant attack, exponential decay: the shape of a percussive sound.
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(options.gain, now + 0.002);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);

    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(target);
    source.start(now, Math.max(0, offset), options.duration + 0.02);
    source.stop(now + options.duration + 0.05);
  }

  /** Sine or triangle tone with a pitch sweep. Used for body thump and death sounds. */
  private tone(options: {
    category: SoundCategory;
    type: OscillatorType;
    from: number;
    to: number;
    duration: number;
    gain: number;
    position?: Vec3;
  }): void {
    const context = this.context;
    if (!context || !this.unlocked) return;
    const target = this.destination(options.category, options.position);
    if (!target) return;

    const now = context.currentTime;
    const osc = context.createOscillator();
    osc.type = options.type;
    osc.frequency.setValueAtTime(options.from, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, options.to), now + options.duration);

    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(options.gain, now + 0.004);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);

    osc.connect(envelope);
    envelope.connect(target);
    osc.start(now);
    osc.stop(now + options.duration + 0.02);
  }

  /** The player's own weapon: loud, close, no panning. */
  playerShot(weaponIndex: number): void {
    // Rifle is deeper and longer than the pistol, so the weapons are distinguishable by ear.
    const rifle = weaponIndex === 0;
    this.noiseBurst({
      category: 'effects',
      duration: rifle ? 0.16 : 0.11,
      frequency: rifle ? 1500 : 2100,
      sweepTo: rifle ? 320 : 520,
      q: 0.9,
      gain: 0.55,
    });
    // Low thump underneath gives the shot weight; without it a noise burst sounds like static.
    this.tone({
      category: 'effects',
      type: 'sine',
      from: rifle ? 170 : 220,
      to: 55,
      duration: 0.13,
      gain: 0.4,
    });
  }

  /** An enemy firing, positioned so the player can tell where it came from. */
  enemyShot(position: Vec3): void {
    this.noiseBurst({
      category: 'effects',
      duration: 0.14,
      frequency: 1250,
      sweepTo: 300,
      q: 1.1,
      gain: 0.42,
      position,
    });
  }

  impact(position: Vec3, onBody: boolean): void {
    this.noiseBurst({
      category: 'effects',
      duration: onBody ? 0.085 : 0.055,
      frequency: onBody ? 700 : 2900,
      q: onBody ? 1.4 : 2.6,
      gain: onBody ? 0.4 : 0.26,
      position,
    });
    if (onBody) {
      this.tone({
        category: 'effects',
        type: 'triangle',
        from: 150,
        to: 70,
        duration: 0.08,
        gain: 0.22,
        position,
      });
    }
  }

  /** Distinct, brighter confirmation so a kill is audible without watching the feed. */
  kill(): void {
    this.tone({ category: 'ui', type: 'triangle', from: 880, to: 1320, duration: 0.09, gain: 0.2 });
    this.tone({ category: 'ui', type: 'sine', from: 1320, to: 1760, duration: 0.11, gain: 0.14 });
  }

  headshot(): void {
    this.tone({ category: 'ui', type: 'square', from: 1400, to: 2100, duration: 0.07, gain: 0.14 });
  }

  enemyDeath(position: Vec3): void {
    this.tone({
      category: 'effects',
      type: 'sawtooth',
      from: 420,
      to: 90,
      duration: 0.34,
      gain: 0.22,
      position,
    });
  }

  footstep(position: Vec3, own: boolean): void {
    this.noiseBurst({
      category: 'footsteps',
      duration: 0.06,
      frequency: own ? 420 : 520,
      q: 1.8,
      gain: own ? 0.16 : 0.24,
      ...(own ? {} : { position }),
    });
  }

  // --- Reload mechanics -----------------------------------------------------------------------
  //
  // One sound with a hardcoded gap could not serve both weapons: the rifle takes 2.1 s and the pistol
  // 1.4 s, so the second click would land in the wrong place on one of them. Each stage has its own
  // sound, triggered when the animation crosses that stage, so audio and animation share a single
  // source of timing and cannot drift.

  /** Magazine catch: a small, bright click. */
  reloadRelease(): void {
    this.noiseBurst({ category: 'effects', duration: 0.035, frequency: 2800, q: 5, gain: 0.2 });
  }

  /** Magazine sliding out of the well: a duller scrape. */
  reloadExtract(): void {
    this.noiseBurst({
      category: 'effects',
      duration: 0.09,
      frequency: 900,
      sweepTo: 420,
      q: 1.6,
      gain: 0.2,
    });
  }

  /** The old magazine hitting the floor, below the player. */
  reloadDrop(position: Vec3): void {
    this.noiseBurst({
      category: 'effects',
      duration: 0.07,
      frequency: 1100,
      q: 2.2,
      gain: 0.16,
      position,
    });
    this.tone({
      category: 'effects',
      type: 'triangle',
      from: 190,
      to: 90,
      duration: 0.09,
      gain: 0.12,
      position,
    });
  }

  /** Fresh magazine going in. */
  reloadInsert(): void {
    this.noiseBurst({
      category: 'effects',
      duration: 0.07,
      frequency: 1400,
      sweepTo: 700,
      q: 2,
      gain: 0.22,
    });
  }

  /** A firm slap to seat the magazine, with a low thump under it for weight. */
  reloadSeat(): void {
    this.noiseBurst({ category: 'effects', duration: 0.055, frequency: 1000, q: 1.5, gain: 0.3 });
    this.tone({ category: 'effects', type: 'sine', from: 160, to: 70, duration: 0.07, gain: 0.2 });
  }

  /** Charging handle, as the weapon comes back to ready. */
  reloadPresent(): void {
    this.noiseBurst({
      category: 'effects',
      duration: 0.06,
      frequency: 2200,
      sweepTo: 1200,
      q: 3,
      gain: 0.22,
    });
  }

  dryFire(): void {
    this.noiseBurst({ category: 'effects', duration: 0.035, frequency: 2600, q: 4, gain: 0.18 });
  }

  playerHurt(): void {
    this.tone({ category: 'ui', type: 'sawtooth', from: 220, to: 110, duration: 0.18, gain: 0.2 });
  }

  medal(): void {
    this.tone({ category: 'ui', type: 'sine', from: 660, to: 990, duration: 0.14, gain: 0.18 });
    setTimeout(() => {
      this.tone({ category: 'ui', type: 'sine', from: 990, to: 1320, duration: 0.18, gain: 0.16 });
    }, 90);
  }

  waveStart(): void {
    this.tone({ category: 'ui', type: 'triangle', from: 180, to: 320, duration: 0.5, gain: 0.2 });
  }

  /** Silence while the tab is hidden, so a backgrounded game is not heard. */
  setSuspended(suspended: boolean): void {
    const context = this.context;
    if (!context) return;
    const state = stateOf(context);
    if (suspended && state === 'running') void context.suspend();
    if (!suspended && this.unlocked && state === 'suspended') void context.resume();
  }

  dispose(): void {
    void this.context?.close();
    this.context = null;
    this.masterGain = null;
    this.categoryGains.clear();
    this.noiseBuffer = null;
    this.unlocked = false;
  }
}
