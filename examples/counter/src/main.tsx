import { KioProvider } from "@kio/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { setupApp } from "./setup";

async function boot() {
	const { client } = await setupApp();

	const root = document.getElementById("root");
	if (!root) throw new Error("Missing #root element");

	createRoot(root).render(
		<StrictMode>
			<KioProvider client={client}>
				<App />
			</KioProvider>
		</StrictMode>,
	);
}

boot();
