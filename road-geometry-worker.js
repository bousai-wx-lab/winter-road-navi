import { buildRoadGeometry } from "./road-geometry.js";

let grid;
self.onmessage = ({ data }) => {
  if (data.type === "init") { grid = data.grid; return; }
  if (data.type !== "build") return;
  try {
    const geometry = buildRoadGeometry(data.features, grid, data.bounds);
    self.postMessage({ generation: data.generation, geometry }, [geometry.general.positions.buffer, geometry.general.cells.buffer, geometry.general.clips.buffer, geometry.highway.positions.buffer, geometry.highway.cells.buffer, geometry.highway.clips.buffer]);
  } catch (error) {
    self.postMessage({ generation: data.generation, error: error.message });
  }
};
