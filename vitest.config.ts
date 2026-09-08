import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	resolve: {
		alias: {
			obsidian: path.resolve(__dirname, "tests/__stubs__/obsidian.ts"),
		},
	},
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
	},
});
