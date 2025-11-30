import { useState, useEffect } from "react";
import { useEarthquakeSonifier } from "./hooks/useEarthquakeSonifier";
import { EarthquakeCanvas, type EarthquakeFeature } from "./EarthquakeCanvas";

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
      <div className="flex-1 relative">
        <EarthquakeCanvas events={visualEvents} />
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
