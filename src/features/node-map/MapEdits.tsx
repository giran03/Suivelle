import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { READ_ONLY } from "../../lib/access";
import { performEdit, redoEdit, undoEdit } from "./editor";
import type { MapData } from "./model";
import { useNodeMap } from "./store";

/** Undo and redo for map edits, as icon buttons in the tool rail. Ctrl+Z works while the map has focus. */
export function MapHistory() {
  const undo=useNodeMap(s=>s.undo),redo=useNodeMap(s=>s.redo),busy=useNodeMap(s=>s.editBusy);
  useEffect(()=>{
    const onKey=(e:KeyboardEvent)=>{if(READ_ONLY||(!e.ctrlKey&&!e.metaKey)||e.key.toLowerCase()!=="z"||!document.activeElement?.closest(".node-map")||(e.target as Element).closest("input,textarea,select,[contenteditable=true]")||document.querySelector("dialog[open]"))return;e.preventDefault();e.stopPropagation();void (e.shiftKey?redoEdit():undoEdit());};
    document.addEventListener("keydown",onKey,true);return()=>document.removeEventListener("keydown",onKey,true);
  },[]);
  if(READ_ONLY||(!undo.length&&!redo.length))return null;
  return <div className="map-rail-group" role="group" aria-label="Map edit history">
    <button type="button" className="map-icon-btn" aria-label="Undo map edit" title="Undo map edit (Ctrl+Z)" disabled={busy||!undo.length} onClick={()=>void undoEdit()}><Icon name="undo"/></button>
    <button type="button" className="map-icon-btn" aria-label="Redo map edit" title="Redo map edit (Ctrl+Shift+Z)" disabled={busy||!redo.length} onClick={()=>void redoEdit()}><Icon name="redo"/></button>
  </div>;
}

/** Connection and bulk edits for the inspector. The source follows the selection; a connect drag fills both ends. */
export function MapEdits({ data, selected, pair, onDone }: { data: MapData | null; selected: string[]; pair: [string,string] | null; onDone?: () => void }) {
  const [source,setSource]=useState(""),[target,setTarget]=useState(""),[kind,setKind]=useState("reference"),[propertyId,setProperty]=useState(""),[relationId,setRelation]=useState(""),[value,setValue]=useState(""),[tag,setTag]=useState("");
  const busy=useNodeMap(s=>s.editBusy),error=useNodeMap(s=>s.editError);
  const details=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{if(selected[0])setSource(selected[0]);},[selected]);
  useEffect(()=>{if(pair){setSource(pair[0]);setTarget(pair[1]);if(details.current)details.current.open=true;}},[pair]);
  if(READ_ONLY)return null;
  const pages=data?.nodes.filter(n=>n.kind!=="workspace")??[];
  const from=pages.find(n=>n.id===source),to=pages.find(n=>n.id===target);
  const relations=data?.properties.filter(p=>p.kind==="relation"&&p.databaseId===from?.databaseId)??[];
  const chosen=selected.map(id=>pages.find(n=>n.id===id)).filter(n=>!!n);
  const commonDatabase=chosen.length&&chosen.every(n=>n.kind==="record"&&n.databaseId===chosen[0].databaseId)?chosen[0].databaseId:null;
  const properties=data?.properties.filter(p=>p.databaseId===commonDatabase&&["status","select","multi_select","date","checkbox","text"].includes(p.kind))??[];
  const bulkProperty=properties.find(p=>p.id===propertyId);
  const options=(bulkProperty?.config.options??[]) as {id:string;name:string}[];
  const editPair=async()=>{
    let success=false;
    if(kind==="reference")success=await performEdit({kind:"reference",source,target});
    else if(kind==="move")success=await performEdit({kind:"move",source,target:target||null});
    else if(relationId){
      success=await performEdit({kind:"relation",source,target,propertyId:relationId,dependency:kind==="dependency"});
      if(success&&kind==="dependency"){const s=useNodeMap.getState();s.configure({dependencyProperties:[...new Set([...s.dependencyProperties,relationId])]});}
    }
    if(success)onDone?.();
  };
  const bulkValue=()=>{let parsed:unknown=value;if(bulkProperty&&["status","select"].includes(bulkProperty.kind)&&!value)parsed=null;if(bulkProperty?.kind==="checkbox")parsed=value==="true";if(bulkProperty?.kind==="date")parsed=value?{start:value}:null;if(bulkProperty?.kind==="multi_select")parsed=value?[value]:[];void performEdit({kind:"setProperty",pageIds:chosen.map(n=>n.id),propertyId,value:parsed});};
  return <details ref={details} className="map-edits">
    <summary>Edit connections{chosen.length>1?` and ${chosen.length} selected`:""}</summary>
    <div className="map-edit-form">
      <label>Source<select aria-label="Connection source" value={source} onChange={e=>setSource(e.target.value)}><option value="">Choose…</option>{pages.map(n=><option key={n.id} value={n.id}>{n.title||"Untitled"}</option>)}</select></label>
      <label>Action<select value={kind} onChange={e=>{setKind(e.target.value);setRelation("");}}><option value="reference">Add page reference</option><option value="move">Move source under target</option><option value="relation">Add database relation</option><option value="dependency">Source blocks target</option></select></label>
      <label>Target<select aria-label="Connection target" value={target} onChange={e=>setTarget(e.target.value)}><option value="">{kind==="move"?"Workspace root":"Choose…"}</option>{pages.filter(n=>n.id!==source).map(n=><option key={n.id} value={n.id}>{n.title||"Untitled"}</option>)}</select></label>
      {["relation","dependency"].includes(kind)&&<label>Relation property<select value={relationId} onChange={e=>setRelation(e.target.value)}><option value="">Choose…</option>{relations.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
      <button type="button" className="btn" disabled={busy||!from||(!to&&kind!=="move")||(["relation","dependency"].includes(kind)&&(!from?.recordId||!to?.recordId||!relations.some(p=>p.id===relationId)))} onClick={editPair}>Apply connection</button>
      <p className="map-edit-hint">References add a paragraph to the source page. Moves change nesting. Dependencies use only the relation property you choose.</p>
    </div>
    <div className="map-edit-form">
      <label>Tag {chosen.length} selected<input value={tag} onChange={e=>setTag(e.target.value)} placeholder="research" maxLength={80}/></label>
      <button type="button" className="btn" disabled={busy||!tag.trim()||!chosen.length||chosen.length>100||chosen.some(n=>!["page","record"].includes(n.kind))} onClick={()=>void performEdit({kind:"tag",pageIds:chosen.map(n=>n.id),tag})}>Tag selected</button>
      {properties.length>0&&<label>Property<select aria-label="Bulk property" value={propertyId} onChange={e=>{setProperty(e.target.value);setValue("");}}><option value="">Choose a record property…</option>{properties.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
      {bulkProperty&&<label>Value{["status","select","multi_select"].includes(bulkProperty.kind)?<select aria-label="Bulk value" value={value} onChange={e=>setValue(e.target.value)}><option value="">Clear value</option>{options.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select>:bulkProperty.kind==="checkbox"?<select aria-label="Bulk value" value={value} onChange={e=>setValue(e.target.value)}><option value="false">Unchecked</option><option value="true">Checked</option></select>:<input aria-label="Bulk value" type={bulkProperty.kind==="date"?"date":"text"} value={value} onChange={e=>setValue(e.target.value)}/>}</label>}
      {bulkProperty&&<button type="button" className="btn" disabled={busy||!chosen.length||chosen.length>100} onClick={bulkValue}>Set property</button>}
    </div>
    {error&&<p className="field-error" role="alert">{error}</p>}
  </details>;
}
