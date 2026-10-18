import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Remembered light/dark choice; the default follows the system.
try {
	const theme = localStorage.getItem("gm-theme");
	if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {}

createRoot(document.getElementById("root")!).render(<App />);
