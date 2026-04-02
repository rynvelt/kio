import { engine } from "@kio/shared";
import { fogChannel, gameChannel, presenceChannel } from "./schema";

export const serverEngine = engine()
	.channel(
		gameChannel
			.serverImpl("visitLocation", {
				validate(shards, input, _ctx, { reject }) {
					if (
						shards.seat(input.seatId).visitedLocations.has(input.locationSlug)
					) {
						return reject("ALREADY_VISITED", "Location already visited");
					}
				},
			})
			.serverImpl("useItem", {
				validate(shards, input, _ctx, { reject }) {
					const item = shards
						.seat(input.seatId)
						.inventory.find((i) => i.id === input.itemId);
					if (!item) return reject("ITEM_NOT_FOUND", "Item not in inventory");
					if (item.quantity < 1)
						return reject("INSUFFICIENT_QUANTITY", "No uses left");
				},
			})
			.serverImpl("chooseDialogueOption", {
				validate(_shards, _input, _ctx, { reject }) {
					return reject("DIALOGUE_NOT_ACTIVE", "No active dialogue");
				},
				apply(shards, input) {
					// Advance dialogue state on the seat
					shards
						.seat(input.seatId)
						.visitedLocations.add(
							`dialogue:${input.dialogueId}:${String(input.optionIndex)}`,
						);
				},
			})
			.serverImpl("transferItem", {
				validate(shards, input, _ctx, { reject }) {
					if (
						!shards
							.seat(input.fromSeatId)
							.inventory.some((i) => i.id === input.itemId)
					) {
						return reject("ITEM_NOT_FOUND", "Item not in source inventory");
					}
				},
				apply(shards, input) {
					const from = shards.seat(input.fromSeatId);
					const to = shards.seat(input.toSeatId);
					const idx = from.inventory.findIndex((i) => i.id === input.itemId);
					const item = from.inventory[idx];
					if (item) {
						from.inventory.splice(idx, 1);
						to.inventory.push(item);
					}
				},
			})
			.serverImpl("rollDice", {
				validate(shards, _input, _ctx, { reject }) {
					if (shards.world.gameStage !== "PLAYING")
						return reject("NOT_PLAYING", "Game is not active");
				},
				compute(_shards, input) {
					return {
						results: input.dice.map(
							(d) => Math.floor(Math.random() * d.max) + 1,
						),
					};
				},
				apply(shards, _input, serverResult) {
					shards.world.turnCount += serverResult.results.length;
				},
			}),
	)
	.channel(presenceChannel)
	.channel(fogChannel);
