import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { maskSerial, parseAdbDevices, probeHeadsets, resolveAdbCandidates } from "./headsetStatus.mjs";

const stamp = "2026-10-26T18:00:00.000Z";
describe("ADB headset parsing", () => {
  it("empty output is disconnected", () => assert.equal(parseAdbDevices("List of devices attached\n", stamp).status, "disconnected"));
  it("authorized USB device is connected and masked", () => {
    const r = parseAdbDevices("List of devices attached\n1WMHH123456789 device usb:1-2 model:Quest_3S transport_id:1\n", stamp);
    assert.equal(r.status, "connected"); assert.equal(r.transport, "usb"); assert.equal(r.model, "Quest 3S");
    assert.equal(r.maskedSerial.endsWith("6789"), true); assert.equal(JSON.stringify(r).includes("1WMHH123456789"), false);
  });
  it("authorized wireless device is connected", () => assert.equal(parseAdbDevices("192.168.1.8:5555 device model:Android_XR\n", stamp).transport, "wireless"));
  it("unauthorized device requests authorization", () => assert.equal(parseAdbDevices("abc unauthorized usb:1-2\n", stamp).status, "authorization_required"));
  it("offline device is offline", () => assert.equal(parseAdbDevices("abc offline usb:1-2\n", stamp).status, "offline"));
  it("multiple devices prefer an authorized device and count all", () => {
    const r=parseAdbDevices("a unauthorized\nb device model:Headset\nc offline\n",stamp); assert.equal(r.status,"connected"); assert.equal(r.deviceCount,3);
  });
  it("maskSerial never returns the complete identifier", () => { const s=maskSerial("SERIAL-SECRET-1234"); assert.equal(s.includes("SECRET"),false); assert.equal(s.endsWith("1234"),true); });
  it("maskSerial hides at least one character from short identifiers", () => { for (const serial of ["a", "abc", "1234"]) assert.equal(maskSerial(serial).includes(serial), false); });
  it("candidate order is configured, env, PATH, Android SDK, Unity SDK", () => {
    const r=resolveAdbCandidates({config:{adbPath:"D:/custom/adb.exe"},env:{HERTZ_ADB_PATH:"E:/env/adb.exe",ANDROID_SDK_ROOT:"F:/sdk",ProgramFiles:"C:/Program Files"},projectRoot:process.cwd(),platform:"win32"});
    assert.deepEqual(r.slice(0,4).map(x=>x.source),["connector_config","HERTZ_ADB_PATH","PATH","ANDROID_SDK_ROOT"]);
  });
  it("resolves the current Unity Editor Android SDK after configured/PATH/ANDROID candidates", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-adb-candidates-"));
    try {
      fs.mkdirSync(path.join(root, "ProjectSettings"), { recursive: true });
      fs.writeFileSync(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.85f1\n");
      const candidates = resolveAdbCandidates({
        config: { adbPath: "D:/custom/adb.exe" },
        env: { HERTZ_ADB_PATH: "E:/env/adb.exe", ANDROID_SDK_ROOT: "F:/sdk", ProgramFiles: "C:/Program Files" },
        projectRoot: root,
        platform: "win32",
      });
      assert.deepEqual(candidates.map((candidate) => candidate.source), [
        "connector_config", "HERTZ_ADB_PATH", "PATH", "ANDROID_SDK_ROOT", "unity_android_sdk",
      ]);
      assert.match(candidates.at(-1).executable.replace(/\\/g, "/"), /Unity\/Hub\/Editor\/6000\.0\.85f1\/Editor\/Data\/PlaybackEngines\/AndroidPlayer\/SDK\/platform-tools\/adb\.exe$/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("reports unavailable when every ADB candidate is missing", async () => {
    const r = await probeHeadsets({ projectRoot: process.cwd(), env: {}, platform: "win32", runAdb: async () => ({ error: { code: "ENOENT" }, stdout: "", stderr: "" }) });
    assert.equal(r.status, "unavailable"); assert.equal(r.adbAvailable, false);
  });
});
