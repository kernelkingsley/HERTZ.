import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HeadsetConnectionCard } from "./Connections.jsx";
import { HEADSET_STATUS_LABELS } from "../lib/headsetDisplay.js";

afterEach(cleanup);

describe("Headset connection card", () => {
  for (const [status, label] of Object.entries(HEADSET_STATUS_LABELS)) {
    it(`renders ${status}`, () => {
      render(<HeadsetConnectionCard headset={{
        status,
        stale: status === "unknown",
        deviceCount: status === "connected" ? 1 : 0,
        model: status === "connected" ? "Quest 3S" : null,
        transport: status === "connected" ? "usb" : null,
        maskedSerial: status === "connected" ? "••••••••1234" : null,
        lastSuccessfulProbeAt: "2026-10-26T18:00:00.000Z",
        adb: { status },
        openxr: { unityConnected: true, loaderActive: true, displayRunning: false, hmdPresent: false },
      }} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText("USB / ADB")).toBeInTheDocument();
      expect(screen.getByText("OpenXR runtime")).toBeInTheDocument();
      expect(screen.getByText(/Headset status is informational/)).toBeInTheDocument();
    });
  }
  it("keeps OpenXR-only identity out of the USB/ADB subsection", () => {
    render(<HeadsetConnectionCard headset={{
      status: "connected",
      stale: false,
      model: "OpenXR HMD",
      transport: "openxr",
      adb: { status: "unavailable", deviceCount: 0, model: null, transport: null, maskedSerial: null },
      openxr: {
        unityConnected: true,
        loaderActive: true,
        displayRunning: true,
        hmdPresent: true,
        deviceName: "OpenXR HMD",
        runtimeName: "OpenXR Runtime",
      },
    }} />);
    expect(screen.getByText("Devices: 0")).toBeInTheDocument();
    expect(screen.getByText("Model: —")).toBeInTheDocument();
    expect(screen.getByText("Transport: —")).toBeInTheDocument();
    expect(screen.getByText("HMD input: OpenXR HMD")).toBeInTheDocument();
  });
});
