import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./client/App";
import { startAnalytics } from "./client/analytics";
import { reportLeavingOnUnload } from "./client/viewer";
import "./index.css";

// Registered once for the page, not per render: closing the tab frees any disk-only film this viewer made.
// Anything the beacon misses is caught by the one-hour cache window on the server.
reportLeavingOnUnload();
void startAnalytics();

const elem = document.getElementById("root")!;
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

(import.meta.hot.data.root ??= createRoot(elem)).render(app);
