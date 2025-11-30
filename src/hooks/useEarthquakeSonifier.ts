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

export function useEarthquakeSonifier(
  options: UseEarthquakeSonifierOptions
): UseEarthquakeSonifierReturn {
  const { features, durationSec = 60 } = options;

  const [isReady, setIsReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const activeNodesRef = useRef<Set<AudioScheduledSourceNode>>(new Set());
  const isSupported =
    typeof window !== "undefined" &&
    ("AudioContext" in window || "webkitAudioContext" in window);

  // Create AudioContext lazily on first start()
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

  const scheduleQuakeSound = useCallback(
    (
      ctx: AudioContext,
      opts: {
        time: number;
        duration: number;
        freq: number;
        gainLevel: number;
        cutoff: number;
        pan: number;
      }
    ) => {
      const { time, duration, freq, gainLevel, cutoff, pan } = opts;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      const panner = ctx.createStereoPanner();

      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, time);

      filter.type = "lowpass";
      filter.frequency.setValueAtTime(cutoff, time);

      panner.pan.setValueAtTime(pan, time);

      // Simple attack/release envelope
      const attack = 0.05;
      const release = 0.5;
      const maxGain = gainLevel;

      gain.gain.setValueAtTime(0.0, time);
      gain.gain.linearRampToValueAtTime(maxGain, time + attack);
      gain.gain.setValueAtTime(maxGain, time + duration - release);
      gain.gain.linearRampToValueAtTime(0.0001, time + duration);

      osc
        .connect(filter)
        .connect(panner)
        .connect(gain)
        .connect(ctx.destination);

      osc.start(time);
      osc.stop(time + duration + 0.1);

      // Track so we can stop early if needed
      activeNodesRef.current.add(osc);
      osc.addEventListener("ended", () => {
        activeNodesRef.current.delete(osc);
      });
    },
    []
  );

  const start = useCallback(async () => {
    if (!features || !features.features.length) return;
    const ctx = getAudioContext();
    if (!ctx) return;

    // Must be triggered by a user gesture; resume if suspended
    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    const quakes = features.features;
    const times = quakes.map((f) => f.properties.time);
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const spanMs = maxTime - minTime || 1;

    const totalDuration = durationSec;
    const timeScale = spanMs / totalDuration; // ms of data per 1 sec of audio
    const now = ctx.currentTime;
    const startOffset = 0.1; // small delay before first sound

    for (const feature of quakes) {
      const { mag, time } = feature.properties;
      const [lon, lat, depthKm] = feature.geometry.coordinates;

      const relMs = time - minTime;
      const t = now + startOffset + relMs / timeScale;

      // Magnitude → frequency + gain
      const magClamped = Math.max(0, Math.min(7, mag || 0));
      const freq = mapRange(magClamped, 0, 7, 220, 1000); // Hz
      const gainLevel = mapRange(magClamped, 0, 7, 0.01, 0.3);

      // Depth → brightness
      const depthClamped = Math.max(0, Math.min(700, depthKm || 0));
      const cutoff = mapRange(depthClamped, 0, 700, 8000, 400); // Hz

      // Latitude → pan (-1..1)
      const pan = mapRange(lat, -90, 90, -1, 1);

      // You can tweak duration per event
      const duration = mapRange(magClamped, 0, 7, 0.4, 1.6);

      scheduleQuakeSound(ctx, {
        time: t,
        duration,
        freq,
        gainLevel,
        cutoff,
        pan,
      });
    }

    setIsPlaying(true);

    // When the full piece should be done, flip isPlaying back
    const estimatedEnd = ctx.currentTime + 0.1 + durationSec + 2;
    const id = setTimeout(() => {
      setIsPlaying(false);
    }, (estimatedEnd - ctx.currentTime) * 1000);

    // Clear timeout if the component unmounts
    return () => clearTimeout(id);
  }, [features, durationSec, getAudioContext, scheduleQuakeSound]);

  const stop = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;

    // Stop all scheduled oscillators
    for (const node of activeNodesRef.current) {
      try {
        node.stop();
      } catch {
        // ignore if already stopped
      }
    }
    activeNodesRef.current.clear();

    setIsPlaying(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stop();
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
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
