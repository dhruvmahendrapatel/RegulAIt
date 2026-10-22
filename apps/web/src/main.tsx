import React from "react";
import { createRoot } from "react-dom/client";
import "./theme/fonts.css";
import "./theme/tokens.css";
import "./theme/global.css";
import App from "./App";

// T1: a chosen palette's sheet is in before the first paint of the app; Aurora (nothing stored) loads nothing more
let palette: string | null = null;
try {
  palette = localStorage.getItem("regulait.palette");
} catch {
  // storage unavailable: Aurora
}
// the app renders whatever happens: a palette module that fails to load means Aurora (data-palette is never set)
void (palette ? import("./theme/palette").then((m) => m.startPalette()) : Promise.resolve())
  .catch(() => undefined)
  .then(() =>
    createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    ),
  );
