import { useEffect, useRef, useState } from "react";
import { READ_ONLY } from "../../lib/access";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { flushAllEditors } from "../editor/flushRegistry";
import type { MapData, MapEdit } from "./model";
import { useNodeMap } from "./store";

/** Map edits use the existing content model; the backend returns a guarded inverse for undo. */
export function MapEdits({ data, selected, pair, onDone }: { data: MapData | null; selected: string[]; pair: [string,string] | null; onDone: () => void }) {
  const [source,setSource]=useState(""),[target,setTarget]=useState(""),[kind,setKind]=useState("reference"),[propertyId,setProperty]=useState(""),[relationId,setRelation]=useState(""),[value,setValue]=useState(""),[tag,setTag]=useState("");
  const [error,setError]=useState(""),[busy,setBusy]=useState(false);
  const undo=useNodeMap(s=>s.undo),redo=useNodeMap(s=>s.redo);
  const setUndo=(update:(old:MapEdit[])=>MapEdit[])=>useNodeMap.setState(s=>({undo:update(s.undo)}));
  const setRedo=(update:MapEdit[]|((old:MapEdit[])=>MapEdit[]))=>useNodeMap.setState(s=>({redo:typeof update==="function"?update(s.redo):update}));
  const lock=useRef(false), details=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{if(selected[0])setSource(selected[0]);},[selected]);
  useEffect(()=>{if(pair){setSource(pair[0]);setTarget(pair[1]);if(details.current)details.current.open=true;}},[pair]);
  const run=async (edit:MapEdit):Promise<MapEdit|null>=>{
    if(READ_ONLY||lock.current)return null;lock.current=true;setBusy(true);setError("");
    try{await flushAllEditors(true);const inverse=await ipc.nodeMapEdit(edit);useWorkspace.getState().bumpData();if(inverse.kind==="blocks")window.dispatchEvent(new CustomEvent("suivelle:map-content-changed",{detail:inverse.changes.map(c=>c.pageId)}));await useWorkspace.getState().reloadTree();onDone();return inverse;}
    catch(e){setError(toAppError(e).message);return null;}
    finally{lock.current=false;setBusy(false);}
  };
  const perform=async (edit:MapEdit)=>{const inverse=await run(edit);if(inverse){setUndo(old=>[...old.slice(-29),inverse]);setRedo([]);}return !!inverse;};
  const undoEdit=async()=>{const edit=undo[undo.length-1];if(!edit)return;const inverse=await run(edit);if(inverse){setUndo(old=>old.slice(0,-1));setRedo(old=>[...old,inverse]);}};
  const redoEdit=async()=>{const edit=redo[redo.length-1];if(!edit)return;const inverse=await run(edit);if(inverse){setRedo(old=>old.slice(0,-1));setUndo(old=>[...old,inverse]);}};
  const actions=useRef({undoEdit,redoEdit});actions.current={undoEdit,redoEdit};
  useEffect(()=>{
    const onKey=(e:KeyboardEvent)=>{if(READ_ONLY||(!e.ctrlKey&&!e.metaKey)||e.key.toLowerCase()!=="z"||!document.activeElement?.closest(".node-map")||(e.target as Element).closest("input,textarea,select,[contenteditable=true]")||document.querySelector("dialog[open]"))return;e.preventDefault();e.stopPropagation();void (e.shiftKey?actions.current.redoEdit():actions.current.undoEdit());};
    document.addEventListener("keydown",onKey,true);return()=>document.removeEventListener("keydown",onKey,true);
  },[]);
  if(READ_ONLY)return null;
  const pages=data?.nodes.filter(n=>n.kind!=="workspace")??[];
  const from=pages.find(n=>n.id===source),to=pages.find(n=>n.id===target);
  const relations=data?.properties.filter(p=>p.kind==="relation"&&p.databaseId===from?.databaseId)??[];
  const chosen=selected.map(id=>pages.find(n=>n.id===id)).filter(n=>!!n);
  const commonDatabase=chosen.length&&chosen.every(n=>n.kind==="record"&&n.databaseId===chosen[0].databaseId)?chosen[0].databaseId:null;
  const properties=data?.properties.filter(p=>p.databaseId===commonDatabase&&["status","select","multi_select","date","checkbox","text"].includes(p.kind))??[];
  const bulkProperty=properties.find(p=>p.id===propertyId);
  const options=(bulkProperty?.config.options??[]) as {id:string;name:string}[];
  const editPair=()=>{
    if(kind==="reference")void perform({kind:"reference",source,target});
    else if(kind==="move")void perform({kind:"move",source,target:target||null});
    else if(relationId)void perform({kind:"relation",source,target,propertyId:relationId,dependency:kind==="dependency"}).then(success=>{if(success&&kind==="dependency"){const s=useNodeMap.getState();s.configure({dependencyProperties:[...new Set([...s.dependencyProperties,relationId])]});}});
  };
  const bulkValue=()=>{let parsed:unknown=value;if(bulkProperty&&["status","select"].includes(bulkProperty.kind)&&!value)parsed=null;if(bulkProperty?.kind==="checkbox")parsed=value==="true";if(bulkProperty?.kind==="date")parsed=value?{start:value}:null;if(bulkProperty?.kind==="multi_select")parsed=value?[value]:[];void perform({kind:"setProperty",pageIds:chosen.map(n=>n.id),propertyId,value:parsed});};
  return <div className="map-edit-shell">
    <div className="map-edit-history"><button type="button" className="btn ghost" disabled={busy||!undo.length} onClick={()=>void undoEdit()} title="Undo map edit (Ctrl+Z)">Undo map edit</button><button type="button" className="btn ghost" disabled={busy||!redo.length} onClick={()=>void redoEdit()} title="Redo map edit (Ctrl+Shift+Z)">Redo</button></div>
    <details ref={details} className="map-edits">
      <summary>Edit connections and selected pages</summary>
      <div className="map-edit-form">
        <label>Source<select aria-label="Connection source" value={source} onChange={e=>setSource(e.target.value)}><option value="">Choose…</option>{pages.map(n=><option key={n.id} value={n.id}>{n.title||"Untitled"}</option>)}</select></label>
        <label>Action<select value={kind} onChange={e=>{setKind(e.target.value);setRelation("");}}><option value="reference">Add page reference</option><option value="move">Move source under target</option><option value="relation">Add database relation</option><option value="dependency">Source blocks target</option></select></label>
        <label>Target<select aria-label="Connection target" value={target} onChange={e=>setTarget(e.target.value)}><option value="">{kind==="move"?"Workspace root":"Choose…"}</option>{pages.filter(n=>n.id!==source).map(n=><option key={n.id} value={n.id}>{n.title||"Untitled"}</option>)}</select></label>
        {["relation","dependency"].includes(kind)&&<label>Relation property<select value={relationId} onChange={e=>setRelation(e.target.value)}><option value="">Choose…</option>{relations.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
        <button type="button" className="btn" disabled={busy||!from||(!to&&kind!=="move")||(["relation","dependency"].includes(kind)&&(!from?.recordId||!to?.recordId||!relations.some(p=>p.id===relationId)))} onClick={editPair}>Apply connection</button>
      </div>
      <p className="map-edit-hint">References add a paragraph to the source page. Moves change nesting. Dependencies use only the relation property you choose.</p>
      <div className="map-edit-form">
        <span>{chosen.length} selected</span><label>Tag<input value={tag} onChange={e=>setTag(e.target.value)} placeholder="research" maxLength={80}/></label>
        <button type="button" className="btn" disabled={busy||!tag.trim()||!chosen.length||chosen.length>100||chosen.some(n=>!["page","record"].includes(n.kind))} onClick={()=>void perform({kind:"tag",pageIds:chosen.map(n=>n.id),tag})}>Tag selected</button>
        <label>Property<select aria-label="Bulk property" value={propertyId} onChange={e=>{setProperty(e.target.value);setValue("");}}><option value="">Choose a record property…</option>{properties.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        {bulkProperty&&<label>Value{["status","select","multi_select"].includes(bulkProperty.kind)?<select aria-label="Bulk value" value={value} onChange={e=>setValue(e.target.value)}><option value="">Clear value</option>{options.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select>:bulkProperty.kind==="checkbox"?<select aria-label="Bulk value" value={value} onChange={e=>setValue(e.target.value)}><option value="false">Unchecked</option><option value="true">Checked</option></select>:<input aria-label="Bulk value" type={bulkProperty.kind==="date"?"date":"text"} value={value} onChange={e=>setValue(e.target.value)}/>}</label>}
        <button type="button" className="btn" disabled={busy||!bulkProperty||!chosen.length||chosen.length>100} onClick={bulkValue}>Set property</button>
      </div>
    </details>
    {error&&<p className="map-notice field-error" role="alert">{error}</p>}
  </div>;
}
