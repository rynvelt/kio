import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"
import mermaid from "astro-mermaid"

export default defineConfig({
	integrations: [
		mermaid({ autoTheme: true }),
		starlight({
			title: "Kio",
			description:
				"Authoritative state synchronization engine for real-time multiplayer applications",
			sidebar: [
				{ slug: "index" },
				{
					label: "Concepts",
					autogenerate: { directory: "concepts" },
				},
				{
					label: "Reference",
					autogenerate: { directory: "reference" },
				},
				{
					label: "Guides",
					autogenerate: { directory: "guides" },
				},
				{
					label: "Project",
					autogenerate: { directory: "project" },
				},
			],
		}),
	],
})
