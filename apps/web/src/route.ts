export type Page = "product" | "try";

/** Two pages and no router: the Worker serves index.html for every path that is not an API route. */
export function pageFor(pathname: string): Page {
  return pathname.replace(/\/+$/, "") === "/try" ? "try" : "product";
}
