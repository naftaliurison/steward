import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { Product } from "./pages/Product";
import { Try } from "./pages/Try";
import { pageFor } from "./route";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");
createRoot(root).render(
  <StrictMode>{pageFor(window.location.pathname) === "try" ? <Try /> : <Product />}</StrictMode>,
);
