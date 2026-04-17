import { BarChart } from "@mantine/charts";
import { Text } from "@mantine/core";
import type { Slide } from "../schema";

const COLORS = ["blue.6", "violet.6", "teal.6", "orange.6", "pink.6", "lime.6"];

export function ResultsChart({
	slide,
	height = 260,
}: {
	slide: Slide;
	height?: number;
}) {
	const data = slide.options.map((opt, idx) => ({
		option: opt.label,
		votes: slide.results[opt.id] ?? 0,
		color: COLORS[idx % COLORS.length] ?? "blue.6",
	}));

	const total = data.reduce((sum, d) => sum + d.votes, 0);

	return (
		<>
			<BarChart
				h={height}
				data={data}
				dataKey="option"
				series={[{ name: "votes", color: "blue.6" }]}
				tickLine="y"
				withBarValueLabel
				valueFormatter={(v) => String(v)}
			/>
			<Text c="dimmed" size="sm" mt="xs">
				{total} {total === 1 ? "vote" : "votes"}
			</Text>
		</>
	);
}
