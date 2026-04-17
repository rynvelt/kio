import "@mantine/core/styles.css";
import "@mantine/charts/styles.css";

import { MantineProvider } from "@mantine/core";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { routeTree } from "./routeTree.gen";

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element");

createRoot(rootElement).render(
	<StrictMode>
		<MantineProvider>
			<RouterProvider router={router} />
		</MantineProvider>
	</StrictMode>,
);
