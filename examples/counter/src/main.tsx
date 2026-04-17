import { KioProvider } from "@kiojs/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { setupApp } from "./setup";

const { client } = setupApp();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
	<StrictMode>
		<KioProvider client={client}>
			<App />
		</KioProvider>
	</StrictMode>,
);
