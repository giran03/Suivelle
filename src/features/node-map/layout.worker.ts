import { forceSimulation, forceManyBody, forceLink, forceX, forceY, forceZ } from "d3-force-3d";
import type { MapData, Position } from "./model";
self.onmessage = (event: MessageEvent<{ data: MapData; positions: Record<string, Position>; pins: Record<string, Position>; flat: boolean }>) => {
  const { data, positions, pins, flat } = event.data;
  const nodes = data.nodes.map(n => { const p = positions[n.id]; const fixed = pins[n.id] ?? (n.kind === "workspace" ? p : null); return {id:n.id,...p,...(fixed?{fx:fixed.x,fy:fixed.y,fz:flat?0:fixed.z}:{})}; });
  const links = data.edges.map(e => ({source:e.source,target:e.target}));
  const simulation = forceSimulation(nodes, flat ? 2 : 3).stop()
    .force("charge",forceManyBody().strength(-180).distanceMax(700))
    .force("links",forceLink(links).id(n=>n.id).distance(100).strength(.08))
    .force("x",forceX(n=>positions[n.id].x).strength(.012))
    .force("y",forceY(n=>positions[n.id].y).strength(.012))
    .force("z",forceZ(n=>flat?0:positions[n.id].z).strength(.012));
  simulation.alpha(.6).tick(150);simulation.stop();
  self.postMessage(Object.fromEntries(nodes.map(n=>[n.id,{x:n.x,y:n.y,z:flat?0:n.z}])));
};
