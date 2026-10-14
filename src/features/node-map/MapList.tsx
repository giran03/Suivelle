import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { PageGlyph } from "../pages/PageGlyph";
import { WorkspaceBadge } from "../workspaces/WorkspaceBadge";
import type { Workspace } from "../../types";
import { NODE_COLORS, type MapNode } from "./model";
export function MapList({ nodes, selected, workspaces, onSelect, onOpen, nodeTones = {} }: { nodeTones?: Record<string, string>; nodes: MapNode[]; selected: string[]; workspaces: Workspace[]; onSelect: (ids:string[])=>void; onOpen:(node:MapNode)=>void }) {
  const viewport=useRef<HTMLDivElement>(null),focus=useRef<number|null>(null);
  const virtual=useVirtualizer({count:nodes.length,getScrollElement:()=>viewport.current,estimateSize:()=>60,overscan:6});
  const items=virtual.getVirtualItems();
  useEffect(()=>{if(focus.current!==null){const button=viewport.current?.querySelector<HTMLButtonElement>(`[data-map-index="${focus.current}"]`);if(button){button.focus();focus.current=null;}}},[items]);
  const select=(n:MapNode,multiple:boolean)=>onSelect(multiple?selected.includes(n.id)?selected.filter(id=>id!==n.id):[...selected,n.id]:[n.id]);
  return <div ref={viewport} className="map-list" tabIndex={0} aria-label="Map nodes"><ul style={{height:virtual.getTotalSize(),position:"relative"}}>{items.map(item=>{
    const n=nodes[item.index];return <li key={n.id} aria-setsize={nodes.length} aria-posinset={item.index+1} style={{position:"absolute",top:0,left:0,right:0,height:item.size,transform:`translateY(${item.start}px)`}}>
      <button type="button" data-map-index={item.index} aria-pressed={selected.includes(n.id)} onClick={e=>select(n,e.ctrlKey||e.metaKey)} onDoubleClick={()=>onOpen(n)} onKeyDown={e=>{
        if(e.key==="Enter"&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();select(n,false);onOpen(n);return;}
        if(["ArrowDown","ArrowUp","Home","End"].includes(e.key)){e.preventDefault();const index=e.key==="Home"?0:e.key==="End"?nodes.length-1:Math.max(0,Math.min(nodes.length-1,item.index+(e.key==="ArrowDown"?1:-1)));focus.current=index;virtual.scrollToIndex(index,{align:"auto"});requestAnimationFrame(()=>{const b=viewport.current?.querySelector<HTMLButtonElement>(`[data-map-index="${index}"]`);if(b){b.focus();focus.current=null;}});}
      }}>{n.kind==="workspace"?<WorkspaceBadge workspace={workspaces.find(w=>w.id===n.workspaceId)??null}/>:<i className="map-node-glyph" style={{color:nodeTones[n.id] ?? `var(${NODE_COLORS[n.kind]})`}} aria-hidden="true"><PageGlyph page={{icon:n.icon,kind:n.kind}}/></i>}<span>{n.title||"Untitled"}</span><small>{n.kind==="workspace"?`${n.count} pages and records`:`${workspaces.find(w=>w.id===n.workspaceId)?.name??"Workspace"} · ${n.kind}`}</small></button>
      <button type="button" className="btn ghost" aria-label={`Open ${n.title||"Untitled"}`} onClick={()=>onOpen(n)}>Open</button>
    </li>;
  })}</ul></div>;
}
