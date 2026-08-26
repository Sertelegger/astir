import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { takeToken } from "./credentials";
import "./app.css";

const root = document.getElementById("root");
const token = takeToken();

if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      {token === null ? (
        <div className="app placeholder">
          <p>
            No token. Open this view with <code>astir view</code>, which supplies one in the URL fragment.
          </p>
        </div>
      ) : (
        <App token={token} />
      )}
    </StrictMode>,
  );
}
