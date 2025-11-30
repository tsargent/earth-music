import { useState, useEffect } from "react";
import {
  useEarthquakeSonifier,
  type EarthquakeFeature,
} from "./hooks/useEarthquakeSonifier";
import { EarthquakeCanvas } from "./EarthquakeCanvas";

export default function EarthquakePage() {
  const [data, setData] = useState<any | null>(null);
  const [visualEvents, setVisualEvents] = useState<EarthquakeFeature[]>([]);

  const handleStart = async () => {
    setVisualEvents([]); // clear canvas state
    await start();
  };

  const handleStop = () => {
    stop();
    setVisualEvents([]); // clear canvas state
  };

  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    const mobile =
      /iphone|ipad|android|mobile|ipod|blackberry|opera mini|iemobile|wpdesktop/.test(
        ua
      );
    setIsMobile(mobile);
  }, []);

  useEffect(() => {
    async function load() {
      const res = await fetch(
        "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=2025-11-28T20:00:00"
      );
      const json = await res.json();
      setData(json);
    }
    load();
  }, []);

  const DURATION = 60;

  const { isSupported, isReady, isPlaying, start, stop } =
    useEarthquakeSonifier({
      features: data,
      durationSec: DURATION,
      onEvent: (feature) => {
        // called in sync with AudioContext schedule
        setVisualEvents((prev) => [...prev, feature]);
      },
    });

  return (
    <div className="min-h-screen flex flex-col bg-black text-white">
      {isMobile && (
        <div className="absolute top-4 inset-x-0 z-50 flex justify-center">
          <div className="bg-white/10 backdrop-blur-md text-white text-xs px-4 py-2 rounded-full border border-white/20">
            Best experienced on a desktop computer
          </div>
        </div>
      )}
      <div className="flex-1 relative">
        <EarthquakeCanvas events={visualEvents} />

        <div
          className={`
      pointer-events-none
      absolute inset-0 z-20
      flex items-center justify-center
      transition-opacity duration-1000
      ${isPlaying ? "opacity-0" : "opacity-100"}
    `}
        >
          <h1 className="text-4xl font-normal tracking-tight text-white/80">
            Music for Earthquakes
          </h1>
        </div>
      </div>

      <div className="p-4 flex items-center justify-center gap-4 border-t border-neutral-800">
        <button
          disabled={!isSupported || !isReady || !data || isPlaying}
          onClick={() => {
            setVisualEvents([]); // clear previous drawing
            handleStart();
          }}
          className="px-4 py-2 border border-neutral-600 rounded-full text-sm"
        >
          {!isSupported
            ? "Web Audio not supported"
            : !data
            ? "Loading data…"
            : isPlaying
            ? "Playing…"
            : "Play"}
        </button>

        {isPlaying && (
          <button
            onClick={handleStop}
            className="px-3 py-1 text-xs border border-neutral-700 rounded-full"
          >
            Stop
          </button>
        )}
      </div>
    </div>
  );
}
