// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect,it,vi } from "vitest";
import { MapEdits, MapHistory } from "./MapEdits";
import type { MapData,MapEdit,MapNode } from "./model";
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
const mocks=vi.hoisted(()=>({edit:vi.fn(),flush:vi.fn().mockResolvedValue(undefined),reload:vi.fn().mockResolvedValue(undefined),bump:vi.fn()}));
vi.mock("../../lib/access",()=>({READ_ONLY:false}));
vi.mock("../../lib/ipc",()=>({ipc:{nodeMapEdit:mocks.edit},toAppError:(e:unknown)=>({message:String(e)})}));
vi.mock("../../stores/workspace",()=>({useWorkspace:{getState:()=>({bumpData:mocks.bump,bumpEditor:mocks.bump,reloadTree:mocks.reload})}}));
vi.mock("../editor/flushRegistry",()=>({flushAllEditors:mocks.flush}));
const node=(id:string):MapNode=>({id,title:id,kind:"page",workspaceId:"w",parentId:null,icon:null,count:0,favorite:false,archived:false,createdAt:"",updatedAt:"",recordId:null,databaseId:null,tags:[],values:{}});
const data:MapData={nodes:[node("a"),node("b")],edges:[],properties:[],totalNodes:2,truncated:false};
it("saves pending editors before editing and passes the server inverse to undo; a failed edit creates no undo step",async()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
 const inverse:MapEdit={kind:"blocks",changes:[{pageId:"a",blockId:"link",dataJson:"{}",position:0,expectedRevision:1}]};
 mocks.edit.mockResolvedValueOnce(inverse).mockResolvedValueOnce({kind:"blocks",changes:[]});
  try{
  await act(async()=>{root.render(<><MapHistory/><MapEdits data={data} selected={["a"]} pair={["a","b"]}/></>);});
  const button=(label:string)=>Array.from(host.querySelectorAll("button")).find(b=>b.textContent===label||b.getAttribute("aria-label")===label)!;
  await act(async()=>button("Apply connection").click());
  expect(mocks.flush).toHaveBeenCalledWith(true);expect(mocks.edit).toHaveBeenNthCalledWith(1,{kind:"reference",source:"a",target:"b"});
  expect(mocks.flush.mock.invocationCallOrder[0]).toBeLessThan(mocks.edit.mock.invocationCallOrder[0]);
  expect(button("Undo map edit").disabled).toBe(false);
  await act(async()=>button("Undo map edit").click());expect(mocks.edit).toHaveBeenNthCalledWith(2,inverse);expect(button("Undo map edit").disabled).toBe(true);
  mocks.edit.mockRejectedValueOnce("Newer content exists");await act(async()=>button("Apply connection").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Newer content exists");expect(button("Undo map edit").disabled).toBe(true);
 }finally{await act(async()=>root.unmount());host.remove();}
});
