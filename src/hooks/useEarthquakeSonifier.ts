// useEarthquakeSonifier.ts
import { useCallback, useEffect, useRef, useState } from "react";

type EarthquakeFeature = {
  properties: {
    mag: number;
    time: number; // Unix ms
    place: string;
  };
  geometry: {
    coordinates: [number, number, number]; // [lon, lat, depthKm]
  };
};

type EarthquakeFeatureCollection = {
  features: EarthquakeFeature[];
};

type UseEarthquakeSonifierOptions = {
  features: EarthquakeFeatureCollection | null;
  /** How long (in seconds) the whole timeline should last. */
  durationSec?: number;
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

type DroneNodes = {
  oscs: OscillatorNode[];
  filter: BiquadFilterNode;
  panner: StereoPannerNode;
  gain: GainNode;
};

export function useEarthquakeSonifier(
  options: UseEarthquakeSonifierOptions
): UseEarthquakeSonifierReturn {
  const { features, durationSec = 60 } = options;

  const [isReady, setIsReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const droneRef = useRef<DroneNodes | null>(null);
  const endTimeoutRef = useRef<number | null>(null);
  const transientNodesRef = useRef<Set<AudioScheduledSourceNode>>(new Set());
  const noiseBufferRef = useRef<AudioBuffer | null>(null);

  const BASE_GAIN = 0.12;
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
    const duration = 0.5;
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

  const ensureDrone = useCallback((ctx: AudioContext): DroneNodes => {
    if (droneRef.current) return droneRef.current;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const osc3 = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const panner = ctx.createStereoPanner();
    const gain = ctx.createGain();

    osc1.type = "sine";
    osc2.type = "sine";
    osc3.type = "sine";

    osc1.frequency.value = 110; // A2
    osc2.frequency.value = 220; // A3
    osc3.frequency.value = 330; // E-ish

    filter.type = "lowpass";
    filter.frequency.value = 1800;
    filter.Q.value = 0.9;

    panner.pan.value = 0;
    gain.gain.value = 0;

    osc1.connect(filter);
    osc2.connect(filter);
    osc3.connect(filter);
    filter.connect(panner).connect(gain).connect(ctx.destination);

    const now = ctx.currentTime;
    osc1.start(now);
    osc2.start(now);
    osc3.start(now);

    const nodes: DroneNodes = {
      oscs: [osc1, osc2, osc3],
      filter,
      panner,
      gain,
    };
    droneRef.current = nodes;
    return nodes;
  }, []);

  const schedulePercussiveHit = useCallback(
    (
      ctx: AudioContext,
      drone: DroneNodes,
      opts: {
        time: number;
        mag: number;
        lat: number;
        depthKm: number;
      }
    ) => {
      const { time, mag, lat, depthKm } = opts;

      const magClamped = Math.max(0, Math.min(7, mag || 0));
      const depthClamped = Math.max(0, Math.min(700, depthKm || 0));

      const panPos = mapRange(lat, -90, 90, -1, 1);
      const hitPan = ctx.createStereoPanner();
      hitPan.pan.setValueAtTime(panPos, time);

      // Noise burst (louder, snappier)
      const noiseSource = ctx.createBufferSource();
      noiseSource.buffer = getNoiseBuffer(ctx);
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = "bandpass";
      const centerFreq = mapRange(depthClamped, 0, 700, 6000, 400);
      noiseFilter.frequency.setValueAtTime(centerFreq, time);
      noiseFilter.Q.setValueAtTime(6, time);

      const noiseGain = ctx.createGain();
      const noiseMaxGain = mapRange(magClamped, 0, 7, 0.05, 0.35);
      noiseGain.gain.setValueAtTime(0, time);
      noiseGain.gain.linearRampToValueAtTime(noiseMaxGain, time + 0.01);
      noiseGain.gain.linearRampToValueAtTime(0.0001, time + 0.18);

      noiseSource
        .connect(noiseFilter)
        .connect(noiseGain)
        .connect(hitPan)
        .connect(drone.gain);

      noiseSource.start(time);
      noiseSource.stop(time + 0.25);

      transientNodesRef.current.add(noiseSource);
      noiseSource.addEventListener("ended", () => {
        transientNodesRef.current.delete(noiseSource);
      });

      // Tuned click (also louder)
      const clickOsc = ctx.createOscillator();
      clickOsc.type = "triangle";
      const baseFreq = 330;
      const clickFreq = baseFreq * mapRange(magClamped, 0, 7, 0.7, 3.0);
      clickOsc.frequency.setValueAtTime(clickFreq, time);

      const clickGain = ctx.createGain();
      const clickMaxGain = mapRange(magClamped, 0, 7, 0.03, 0.2);
      clickGain.gain.setValueAtTime(0, time);
      clickGain.gain.linearRampToValueAtTime(clickMaxGain, time + 0.005);
      clickGain.gain.linearRampToValueAtTime(0.0001, time + 0.15);

      clickOsc.connect(clickGain).connect(hitPan).connect(drone.gain);

      clickOsc.start(time);
      clickOsc.stop(time + 0.2);

      transientNodesRef.current.add(clickOsc);
      clickOsc.addEventListener("ended", () => {
        transientNodesRef.current.delete(clickOsc);
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

    // Fade in base drone
    drone.gain.gain.cancelScheduledValues(now);
    drone.gain.gain.setValueAtTime(0, now);
    drone.gain.gain.linearRampToValueAtTime(BASE_GAIN, now + 3);

    const quakes = features.features;
    const times = quakes.map((f) => f.properties.time);
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const spanMs = maxTime - minTime || 1;

    const totalDuration = durationSec;
    const timeScale = spanMs / totalDuration;
    const startOffset = 0.5;

    for (const feature of quakes) {
      const { mag, time } = feature.properties;
      const [lon, lat, depthKm] = feature.geometry.coordinates;

      const relMs = time - minTime;
      const t = now + startOffset + relMs / timeScale;

      const magClamped = Math.max(0, Math.min(7, mag || 0));
      const depthClamped = Math.max(0, Math.min(700, depthKm || 0));

      // 1. Master gain swell based on magnitude
      const swellFactor = mapRange(magClamped, 0, 7, 1.05, 2.0); // up to 2x
      const peakGain = BASE_GAIN * swellFactor;

      drone.gain.gain.cancelScheduledValues(t);
      drone.gain.gain.setValueAtTime(drone.gain.gain.value || BASE_GAIN, t);
      drone.gain.gain.linearRampToValueAtTime(peakGain, t + 0.4);
      drone.gain.gain.linearRampToValueAtTime(BASE_GAIN, t + 3.0);

      // 2. Depth → big filter sweep
      const targetCutoff = mapRange(depthClamped, 0, 700, 9000, 250);
      const baseCutoff = 1800;

      drone.filter.frequency.cancelScheduledValues(t);
      drone.filter.frequency.setValueAtTime(
        drone.filter.frequency.value || baseCutoff,
        t
      );
      drone.filter.frequency.linearRampToValueAtTime(targetCutoff, t + 0.7);
      drone.filter.frequency.linearRampToValueAtTime(baseCutoff, t + 4.0);

      // 3. Latitude → wider, quicker pan sweep
      const panTarget = mapRange(lat, -90, 90, -1, 1);
      const basePan = 0;

      drone.panner.pan.cancelScheduledValues(t);
      drone.panner.pan.setValueAtTime(drone.panner.pan.value || basePan, t);
      drone.panner.pan.linearRampToValueAtTime(panTarget, t + 0.5);
      drone.panner.pan.linearRampToValueAtTime(basePan, t + 2.5);

      // 4. Magnitude → stronger detune shimmer
      const magNorm = mapRange(magClamped, 0, 7, 0, 1);
      const detuneRangeCents = 120; // much wider
      const detuneTarget = (magNorm - 0.5) * 2 * detuneRangeCents; // -120..120

      for (const osc of drone.oscs) {
        osc.detune.cancelScheduledValues(t);
        osc.detune.setValueAtTime(0, t);
        osc.detune.linearRampToValueAtTime(detuneTarget, t + 1.0);
        osc.detune.linearRampToValueAtTime(0, t + 5.0);
      }

      // 5. Percussive hit on top
      schedulePercussiveHit(ctx, drone, {
        time: t,
        mag,
        lat,
        depthKm,
      });
    }

    setIsPlaying(true);

    const estimatedEnd = now + startOffset + durationSec + 3;
    if (endTimeoutRef.current) {
      window.clearTimeout(endTimeoutRef.current);
    }
    endTimeoutRef.current = window.setTimeout(() => {
      const ctxNow = ctx.currentTime;
      const droneNow = droneRef.current;
      if (droneNow) {
        droneNow.gain.gain.cancelScheduledValues(ctxNow);
        droneNow.gain.gain.setValueAtTime(droneNow.gain.gain.value, ctxNow);
        droneNow.gain.gain.linearRampToValueAtTime(0, ctxNow + 3);
      }
      setIsPlaying(false);
    }, (estimatedEnd - now) * 1000);
  }, [
    features,
    durationSec,
    getAudioContext,
    ensureDrone,
    schedulePercussiveHit,
    BASE_GAIN,
  ]);

  const stop = useCallback(() => {
    const ctx = audioCtxRef.current;
    const drone = droneRef.current;

    if (ctx && drone) {
      const now = ctx.currentTime;

      drone.gain.gain.cancelScheduledValues(now);
      drone.gain.gain.setValueAtTime(drone.gain.gain.value, now);
      drone.gain.gain.linearRampToValueAtTime(0, now + 1.5);

      for (const osc of drone.oscs) {
        try {
          osc.stop(now + 2);
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
