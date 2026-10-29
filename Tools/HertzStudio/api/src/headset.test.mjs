import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeHeadsetConnection, sanitizeHeadsetReport } from "./headset.mjs";
const now=Date.parse("2026-10-26T18:00:10.000Z");
function report(status, extra={}) { return sanitizeHeadsetReport({ status, observedAt:"2026-10-26T18:00:05.000Z", lastSuccessfulProbeAt:"2026-10-26T18:00:05.000Z", adbAvailable:status!=="unavailable", ...extra }, "2026-10-26T18:00:05.000Z"); }
describe("normalized headset connection",()=>{
  it("handles ADB unavailable",()=>assert.equal(normalizeHeadsetConnection(report("unavailable"),{now}).status,"unavailable"));
  it("handles empty successful ADB output",()=>assert.equal(normalizeHeadsetConnection(report("disconnected"),{now}).status,"disconnected"));
  it("keeps Unity connected while headset is disconnected",()=>{const r=report("disconnected",{unityConnected:true,openxr:{loaderActive:true,displayRunning:false,hmdPresent:false}}); assert.equal(normalizeHeadsetConnection(r,{now}).status,"disconnected");});
  it("reports headset detected while Unity is offline",()=>{const r=report("connected",{unityConnected:false,maskedSerial:"raw-secret-1234",deviceCount:1}); const n=normalizeHeadsetConnection(r,{now}); assert.equal(n.status,"connected"); assert.equal(n.openxr.unityConnected,false); assert.equal(JSON.stringify(n).includes("raw-secret"),false);});
  it("never exposes a complete short serial from an untrusted report",()=>{for(const serial of ["a","abc","1234"]){const n=normalizeHeadsetConnection(report("connected",{maskedSerial:serial,deviceCount:1}),{now}); assert.equal(JSON.stringify(n).includes(`"${serial}"`),false);}});
  it("does not treat configured/active OpenXR loader as a running HMD",()=>{const r=report("disconnected",{unityConnected:true,openxr:{loaderActive:true,displayRunning:false,hmdPresent:false,runtimeName:"OpenXR"}}); assert.equal(normalizeHeadsetConnection(r,{now}).status,"disconnected");});
  it("accepts running OpenXR HMD separately when ADB is unavailable",()=>{const r=report("unavailable",{unityConnected:true,openxr:{loaderActive:true,displayRunning:true,hmdPresent:true,deviceName:"PC HMD"}}); assert.equal(normalizeHeadsetConnection(r,{now}).status,"connected");});
  it("downgrades stale reports to unknown",()=>{const r=report("connected"); assert.equal(normalizeHeadsetConnection(r,{now:now+30000,staleAfterMs:20000}).status,"unknown"); assert.equal(normalizeHeadsetConnection(r,{now:now+30000,staleAfterMs:20000}).stale,true);});
  for (const status of ["authorization_required","offline"]) it(`preserves ${status}`,()=>assert.equal(normalizeHeadsetConnection(report(status),{now}).status,status));
});
