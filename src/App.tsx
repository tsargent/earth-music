import { useState, useEffect } from "react";
import "./App.css";
import { useEarthquakeSonifier } from "./hooks/useEarthquakeSonifier";

const URI = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=2025-11-29T20:00:00`;

function App() {
  const [data, setData] = useState(null);
  useEffect(() => {
    async function fetchData() {
      const response = await fetch(URI);
      const json = await response.json();
      setData(json);
    }
    fetchData();
  }, []);

  const { isSupported, isReady, isPlaying, start, stop } =
    useEarthquakeSonifier({
      features: data,
      durationSec: 60, // compress whole window into a 60s piece
    });

  if (!isSupported) {
    return <p>Web Audio API not supported in this browser.</p>;
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-black text-white">
      <h1 className="text-xl font-medium tracking-tight">
        Earthquake Sonifier
      </h1>
      <p className="text-sm text-neutral-400 max-w-sm text-center">
        Plays earthquakes from the USGS feed as pitched, spatialized tones,
        compressed into a short timeline.
      </p>

      <button
        disabled={!isReady || !data || isPlaying}
        onClick={start}
        className="px-4 py-2 border border-neutral-600 rounded-full text-sm"
      >
        {!data
          ? "Loading data…"
          : !isReady
          ? "Audio not ready"
          : isPlaying
          ? "Playing…"
          : "Play timeline"}
      </button>

      {isPlaying && (
        <button
          onClick={stop}
          className="px-3 py-1 text-xs border border-neutral-700 rounded-full"
        >
          Stop
        </button>
      )}
    </div>
  );
}

export default App;
