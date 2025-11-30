// useEarthquakeSonifier.ts
import { useCallback, useEffect, useRef, useState } from "react";

export type EarthquakeFeature = {
  properties: {
    mag: number;
    time: number; // Unix ms
    place: string;
  };
  geometry: {
    coordinates: [number, number, number]; // [lon, lat, depthKm]
  };
};

export type EarthquakeFeatureCollection = {
  features: EarthquakeFeature[];
};

type UseEarthquakeSonifierOptions = {
  features: EarthquakeFeatureCollection | null;
  /** How long (in seconds) the whole timeline should last. */
  durationSec?: number;
  /** Called in sync with each event, based on AudioContext schedule. */
  onEvent?: (feature: EarthquakeFeature) => void;
};

type UseEarthquakeSonifierReturn = {
  isSupported: boolean;
  isReady: boolean;
  isPlaying: boolean;
  start: () => Promise<void>;
  stop: () => void;
};

function mapRange(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number
) {
  if (Number.isNaN(value)) return outMin;
  const clamped = Math.min(inMax, Math.max(inMin, value));
  const norm = inMax === inMin ? 0 : (clamped - inMin) / (inMax - inMin);
  return outMin + norm * (outMax - outMin);
}

/** Simple generated impulse response for reverb. */
function createImpulseResponse(
  ctx: AudioContext,
  duration = 4.0,
  decay = 2.5
): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = sampleRate * duration;
  const impulse = ctx.createBuffer(2, length, sampleRate);

  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const env = Math.pow(1 - t, decay);
      data[i] = (Math.random() * 2 - 1) * env;
    }
  }

  return impulse;
}

type DroneNodes = {
  oscs: OscillatorNode[];
  filter: BiquadFilterNode;
  panner: StereoPannerNode;
  gain: GainNode;
  delay: DelayNode;
  delayFeedback: GainNode;
  reverb: ConvolverNode;
  reverbSend: GainNode;
};

export function useEarthquakeSonifier(
  options: UseEarthquakeSonifierOptions
): UseEarthquakeSonifierReturn {
  const { features, durationSec = 60, onEvent } = options;

  const [isReady, setIsReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const droneRef = useRef<DroneNodes | null>(null);
  const endTimeoutRef = useRef<number | null>(null);
  const transientNodesRef = useRef<Set<AudioScheduledSourceNode>>(new Set());
  const noiseBufferRef = useRef<AudioBuffer | null>(null);
  const reverbBufferRef = useRef<AudioBuffer | null>(null);
  const visualTimeoutsRef = useRef<number[]>([]);

  // Drone level; events sit on top of this.
  const BASE_GAIN = 0.06;

  const isSupported =
    typeof window !== "undefined" &&
    ("AudioContext" in window || "webkitAudioContext" in window);

  const getAudioContext = useCallback((): AudioContext | null => {
    if (!isSupported) return null;
    if (audioCtxRef.current) return audioCtxRef.current;

    const AC =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    const ctx = new AC() as AudioContext;
    audioCtxRef.current = ctx;
    return ctx;
  }, [isSupported]);

  useEffect(() => {
    if (isSupported) setIsReady(true);
  }, [isSupported]);

  const getNoiseBuffer = useCallback((ctx: AudioContext): AudioBuffer => {
    if (noiseBufferRef.current) return noiseBufferRef.current;
    const duration = 1.0;
    const buffer = ctx.createBuffer(
      1,
      ctx.sampleRate * duration,
      ctx.sampleRate
    );
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    noiseBufferRef.current = buffer;
    return buffer;
  }, []);

  const getReverbBuffer = useCallback((ctx: AudioContext): AudioBuffer => {
    if (reverbBufferRef.current) return reverbBufferRef.current;
    reverbBufferRef.current = createImpulseResponse(ctx, 5.0, 2.8);
    return reverbBufferRef.current;
  }, []);

  const ensureDrone = useCallback(
    (ctx: AudioContext): DroneNodes => {
      if (droneRef.current) return droneRef.current;

      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const osc3 = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const panner = ctx.createStereoPanner();
      const gain = ctx.createGain();
      const delay = ctx.createDelay(4.0);
      const delayFeedback = ctx.createGain();

      const reverb = ctx.createConvolver();
      reverb.buffer = getReverbBuffer(ctx);
      const reverbSend = ctx.createGain();
      reverbSend.gain.value = 0.4;

      osc1.type = "sine";
      osc2.type = "sine";
      osc3.type = "sine";

      // Simple cluster chord
      osc1.frequency.value = 130.81; // C3
      osc2.frequency.value = 164.81; // E3
      osc3.frequency.value = 196.0; // G3

      filter.type = "lowpass";
      filter.frequency.value = 1800;
      filter.Q.value = 0.7;

      panner.pan.value = 0;
      gain.gain.value = 0; // fade in

      delay.delayTime.value = 0.6;
      delayFeedback.gain.value = 0.35;

      // Routing: oscs -> filter -> panner -> gain
      osc1.connect(filter);
      osc2.connect(filter);
      osc3.connect(filter);

      filter.connect(panner);
      panner.connect(gain);

      // Dry
      gain.connect(ctx.destination);

      // Delay
      const delaySend = ctx.createGain();
      delaySend.gain.value = 0.3;
      gain.connect(delaySend);
      delaySend.connect(delay);
      delay.connect(delayFeedback);
      delayFeedback.connect(delay);
      delay.connect(ctx.destination);

      // Reverb
      gain.connect(reverbSend);
      reverbSend.connect(reverb);
      reverb.connect(ctx.destination);

      const now = ctx.currentTime;
      osc1.start(now);
      osc2.start(now);
      osc3.start(now);

      const nodes: DroneNodes = {
        oscs: [osc1, osc2, osc3],
        filter,
        panner,
        gain,
        delay,
        delayFeedback,
        reverb,
        reverbSend,
      };

      droneRef.current = nodes;
      return nodes;
    },
    [getReverbBuffer]
  );

  /**
   * Ambient event voice:
   * - G major-ish pentatonic note
   * - panned by latitude
   * - brightness from depth
   * - gain from magnitude
   */
  const scheduleEventVoice = useCallback(
    (
      ctx: AudioContext,
      drone: DroneNodes,
      opts: { time: number; mag: number; lat: number; depthKm: number }
    ) => {
      const { time, mag, lat, depthKm } = opts;

      const magClamped = Math.max(0, Math.min(7, mag || 0));
      const depthClamped = Math.max(0, Math.min(700, depthKm || 0));

      const panPos = mapRange(lat, -90, 90, -0.9, 0.9);
      const voicePan = ctx.createStereoPanner();
      voicePan.pan.setValueAtTime(panPos, time);

      // Pitch from major pentatonic
      const root = 196; // G3-ish
      const scaleSemis = [0, 2, 4, 7, 9];
      const idx = Math.floor(
        mapRange(magClamped, 0, 7, 0, scaleSemis.length - 0.001)
      );
      const semis = scaleSemis[idx];
      const freq = root * Math.pow(2, semis / 12);

      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, time);

      const voiceGain = ctx.createGain();
      const peakGain = mapRange(magClamped, 0, 7, 0.03, 0.18);
      const attack = 0.8;
      const release = 5.0;

      const startTime = time - 0.02;
      const safeStart = Math.max(ctx.currentTime, startTime);

      voiceGain.gain.setValueAtTime(0, safeStart);
      voiceGain.gain.linearRampToValueAtTime(peakGain, time + attack);
      voiceGain.gain.linearRampToValueAtTime(0.0001, time + release);

      osc.connect(voiceGain).connect(voicePan).connect(drone.gain);

      osc.start(safeStart);
      osc.stop(time + release + 0.5);

      transientNodesRef.current.add(osc);
      osc.addEventListener("ended", () => {
        transientNodesRef.current.delete(osc);
      });

      // Airy high noise, depth -> brightness
      const noiseSource = ctx.createBufferSource();
      noiseSource.buffer = getNoiseBuffer(ctx);

      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = "bandpass";
      const centerFreq = mapRange(depthClamped, 0, 700, 9000, 600);
      noiseFilter.frequency.setValueAtTime(centerFreq, time);
      noiseFilter.Q.setValueAtTime(3.0, time);

      const noiseGain = ctx.createGain();
      const noisePeak = mapRange(magClamped, 0, 7, 0.01, 0.06);
      const nAttack = 0.6;
      const nRelease = 3.5;

      noiseGain.gain.setValueAtTime(0, safeStart);
      noiseGain.gain.linearRampToValueAtTime(noisePeak, time + nAttack);
      noiseGain.gain.linearRampToValueAtTime(0.0001, time + nRelease);

      noiseSource
        .connect(noiseFilter)
        .connect(noiseGain)
        .connect(voicePan)
        .connect(drone.gain);

      noiseSource.start(safeStart);
      noiseSource.stop(time + nRelease + 0.5);

      transientNodesRef.current.add(noiseSource);
      noiseSource.addEventListener("ended", () => {
        transientNodesRef.current.delete(noiseSource);
      });
    },
    [getNoiseBuffer]
  );

  const start = useCallback(async () => {
    if (!features || !features.features.length) return;
    const ctx = getAudioContext();
    if (!ctx) return;

    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    const drone = ensureDrone(ctx);
    const now = ctx.currentTime;

    // Fade in drone once
    drone.gain.gain.cancelScheduledValues(now);
    drone.gain.gain.setValueAtTime(0, now);
    drone.gain.gain.linearRampToValueAtTime(BASE_GAIN, now + 5);

    const quakes = features.features;
    const times = quakes.map((f) => f.properties.time);
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const spanMs = maxTime - minTime || 1;

    const totalDuration = durationSec;
    const timeScale = spanMs / totalDuration;
    const startOffset = 1.0;

    visualTimeoutsRef.current.forEach((id) => window.clearTimeout(id));
    visualTimeoutsRef.current = [];

    for (const feature of quakes) {
      const { mag, time } = feature.properties;
      const [, lat, depthKm] = feature.geometry.coordinates;

      const relMs = time - minTime;
      const t = now + startOffset + relMs / timeScale;

      // Event voice only – no more global gain / filter / pan automation
      scheduleEventVoice(ctx, drone, {
        time: t,
        mag,
        lat,
        depthKm,
      });

      // Visual callback synced to AudioContext time
      if (onEvent) {
        const delayMs = Math.max(0, (t - ctx.currentTime) * 1000);
        const timeoutId = window.setTimeout(() => {
          onEvent(feature);
        }, delayMs);
        visualTimeoutsRef.current.push(timeoutId);
      }
    }

    setIsPlaying(true);

    const estimatedEnd = now + startOffset + durationSec + 10;
    if (endTimeoutRef.current) {
      window.clearTimeout(endTimeoutRef.current);
    }
    endTimeoutRef.current = window.setTimeout(() => {
      const ctxNow = ctx.currentTime;
      const droneNow = droneRef.current;
      if (droneNow) {
        droneNow.gain.gain.cancelScheduledValues(ctxNow);
        droneNow.gain.gain.setValueAtTime(droneNow.gain.gain.value, ctxNow);
        droneNow.gain.gain.linearRampToValueAtTime(0, ctxNow + 5);
      }
      setIsPlaying(false);
    }, (estimatedEnd - now) * 1000);
  }, [
    features,
    durationSec,
    onEvent,
    getAudioContext,
    ensureDrone,
    scheduleEventVoice,
    BASE_GAIN,
  ]);

  const stop = useCallback(() => {
    const ctx = audioCtxRef.current;
    const drone = droneRef.current;

    if (ctx && drone) {
      const now = ctx.currentTime;

      drone.gain.gain.cancelScheduledValues(now);
      drone.gain.gain.setValueAtTime(drone.gain.gain.value, now);
      drone.gain.gain.linearRampToValueAtTime(0, now + 2.5);

      for (const osc of drone.oscs) {
        try {
          osc.stop(now + 3);
        } catch {
          // ignore
        }
      }
    }

    for (const node of transientNodesRef.current) {
      try {
        node.stop();
      } catch {
        // ignore
      }
    }
    transientNodesRef.current.clear();

    visualTimeoutsRef.current.forEach((id) => window.clearTimeout(id));
    visualTimeoutsRef.current = [];

    if (endTimeoutRef.current) {
      window.clearTimeout(endTimeoutRef.current);
      endTimeoutRef.current = null;
    }

    setIsPlaying(false);
  }, []);

  useEffect(() => {
    return () => {
      stop();
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
      droneRef.current = null;
      noiseBufferRef.current = null;
      reverbBufferRef.current = null;
      visualTimeoutsRef.current.forEach((id) => window.clearTimeout(id));
      visualTimeoutsRef.current = [];
    };
  }, [stop]);

  return {
    isSupported,
    isReady,
    isPlaying,
    start,
    stop,
  };
}
