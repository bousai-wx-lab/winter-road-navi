export const ROAD_TILE_URL = "https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/{z}/{x}/{y}.pbf";
export const BASE_TILE_URL = "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png";
export const JAPAN_VIEW = Object.freeze({ center: [137.2, 37.0], zoom: 5 });

const numeric = (property, fallback = -1) => ["to-number", ["get", property], fallback];

export const HIGHWAY_FILTER = Object.freeze([
  "any",
  ["==", numeric("motorway", 0), 1],
  ["==", numeric("rdCtg"), 3],
  ["match", numeric("ftCode"), [52703, 52704], true, false],
]);

export const GENERAL_ROAD_FILTER = Object.freeze([
  "all",
  ["match", numeric("ftCode"), [2701, 2702, 2703, 2704, 52701, 52702], true, false],
  ["!=", numeric("motorway", 0), 1],
  ["!=", numeric("rdCtg"), 3],
]);

const roadWidth = (small, large) => ["interpolate", ["linear"], ["zoom"], 5, small, 15, large];

export function createMapStyle(temperatureData = { type: "FeatureCollection", features: [] }) {
  return {
    version: 8,
    sources: {
      background: {
        type: "raster",
        tiles: [BASE_TILE_URL],
        tileSize: 256,
        minzoom: 5,
        maxzoom: 18,
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener noreferrer">地理院タイル</a>',
      },
      roads: {
        type: "vector",
        tiles: [ROAD_TILE_URL],
        minzoom: 4,
        maxzoom: 16,
        bounds: [122, 20, 154, 47],
        attribution: '<a href="https://maps.gsi.go.jp/development/vt.html" target="_blank" rel="noopener noreferrer">地理院地図Vector</a>',
      },
      temperatureNormals: {
        type: "geojson",
        data: temperatureData,
        attribution: '<a href="https://www.data.jma.go.jp/obd/stats/data/mdrr/normal/index.html" target="_blank" rel="noopener noreferrer">気象庁 日別平年値</a>を加工',
      },
    },
    layers: [
      { id: "background-map", type: "raster", source: "background", minzoom: 4, paint: { "raster-opacity": 0.75, "raster-saturation": -0.55, "raster-contrast": 0.05 } },
      {
        id: "temperature-normal-halo",
        type: "circle",
        source: "temperatureNormals",
        minzoom: 4,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4.7, 34, 8, 52, 12, 76],
          "circle-color": ["interpolate", ["linear"], ["get", "temperature"], -30, "#281052", -20, "#3a3f9e", -10, "#397fd0", 0, "#80d9eb", 10, "#e8f4cf", 20, "#ffc36d", 30, "#ef6b5b"],
          "circle-opacity": 0.58,
          "circle-blur": 0.82,
        },
      },
      {
        id: "temperature-normal-core",
        type: "circle",
        source: "temperatureNormals",
        minzoom: 4,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4.7, 8, 8, 13, 12, 18],
          "circle-color": ["interpolate", ["linear"], ["get", "temperature"], -30, "#281052", -20, "#3a3f9e", -10, "#397fd0", 0, "#80d9eb", 10, "#e8f4cf", 20, "#ffc36d", 30, "#ef6b5b"],
          "circle-opacity": 0.74,
          "circle-blur": 0.5,
        },
      },
      {
        id: "general-road-casing",
        type: "line",
        source: "roads",
        "source-layer": "road",
        minzoom: 5,
        filter: GENERAL_ROAD_FILTER,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": roadWidth(1.8, 7.5), "line-opacity": 0.96 },
      },
      {
        id: "general-road",
        type: "line",
        source: "roads",
        "source-layer": "road",
        minzoom: 5,
        filter: GENERAL_ROAD_FILTER,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#2d6fa8", "line-width": roadWidth(0.8, 4.2), "line-opacity": 0.95 },
      },
      {
        id: "highway-casing",
        type: "line",
        source: "roads",
        "source-layer": "road",
        minzoom: 5,
        filter: HIGHWAY_FILTER,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": roadWidth(3.6, 9.5), "line-opacity": 0.98 },
      },
      {
        id: "highway",
        type: "line",
        source: "roads",
        "source-layer": "road",
        minzoom: 5,
        filter: HIGHWAY_FILTER,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#0a8d92", "line-width": roadWidth(2.2, 6.3), "line-opacity": 0.98 },
      },
    ],
  };
}

export function classifyRoad(properties = {}) {
  const motorway = Number(properties.motorway);
  const category = Number(properties.rdCtg);
  const featureCode = Number(properties.ftCode);
  if (motorway === 1 || category === 3 || featureCode === 52703 || featureCode === 52704) {
    return "highway";
  }
  return "general";
}
