import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { freezeE2eModeFromBoot } from "./lib/e2eMode.js";
import App from "./App.jsx";
import "./styles.css";

// Capture E2E mode before React mounts (init script / ?hertzE2e=1 only).
freezeE2eModeFromBoot();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
