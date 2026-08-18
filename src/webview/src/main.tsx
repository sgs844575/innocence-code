import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/app.css";

// The real app shell is code-split (dynamic import) so the startup loader in
// index.html stays meaningful while the shell chunk loads.
async function boot(): Promise<void> {
  const [{ App }, { initTheme }] = await Promise.all([
    import("./App"),
    import("./lib/theme"),
  ]);
  initTheme();

  const container = document.getElementById("root");
  if (!container) throw new Error("#root missing in index.html");
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

boot().catch((err) => {
  // Replace the startup loader with the error so failures are visible.
  const container = document.getElementById("root");
  if (container) {
    container.textContent = `InnocenceCode failed to start: ${String(err)}`;
  }
  console.error(err);
});
