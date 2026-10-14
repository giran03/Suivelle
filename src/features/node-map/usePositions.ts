import { useEffect, useMemo, useRef, useState } from "react";
import { coordinates, type Layout, type MapData, type Position } from "./model";
const cache = new Map<string, Record<string, Position>>();
export function usePositions(data: MapData | null, layout: Layout, flat: boolean, propertyId: string, pins: Record<string, Position>, key: string) {
  const fallback = useMemo(()=>data?coordinates(data,layout,flat,propertyId,pins):{},[data,layout,flat,propertyId,pins]);
  const topology=useMemo(()=>data?`${data.nodes.map(n=>`${n.id}:${n.workspaceId}`).join(",")}|${data.edges.map(e=>e.id).join(",")}`:"",[data]);
  const latest=useRef({data,fallback});latest.current={data,fallback};
  const [settled,setSettled]=useState<{key:string; topology:string; positions:Record<string,Position>}|null>(null);
  const [working,setWorking]=useState(false),[failed,setFailed]=useState(false);
  useEffect(()=>{
    const {data,fallback}=latest.current;
    setFailed(false);if(!data || layout!=="organic"){setWorking(false);return;}
    setWorking(true);let worker:Worker;
    try {worker=new Worker(new URL("./layout.worker.ts",import.meta.url),{type:"module"});}catch{setWorking(false);setFailed(true);return;}
    worker.onmessage=(e:MessageEvent<Record<string,Position>>)=>{cache.set(key,e.data);if(cache.size>30)cache.delete(cache.keys().next().value!);setSettled({key,topology,positions:e.data});setWorking(false);worker.terminate();};
    worker.onerror=()=>{setWorking(false);setFailed(true);worker.terminate();};
    const previous=cache.get(key)??{};
    const positions=Object.fromEntries(data.nodes.map(n=>[n.id,pins[n.id]??previous[n.id]??fallback[n.id]]));
    worker.postMessage({data,positions,pins,flat});
    return ()=>worker.terminate();
  },[topology,layout,flat,pins,key]);
  return {positions:layout==="organic"&&settled?.key===key&&settled.topology===topology?settled.positions:fallback,working,failed};
}
