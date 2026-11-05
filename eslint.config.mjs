import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

const nodeOnly = [
	{ name: "fs", message: "Not available on mobile; use the Obsidian vault API." },
	{ name: "path", message: "Not available on mobile; use obsidian normalizePath." },
	{ name: "electron", message: "Not available on mobile." },
	{ name: "child_process", message: "Not available on mobile." },
];
const nodeColon = { group: ["node:*"], message: "Node built-ins are not allowed in src/." };

export default defineConfig([
	globalIgnores(["main.js", "node_modules/**", "legacy/**", "video/**", "fixtures/**"]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.*", "esbuild.config.*", "tests/*.js", "tests/*.cjs"],
				},
			},
		},
	},
	{
		// The e2e runner is a Node CLI (CommonJS) that drives Obsidian from outside.
		files: ["tests/*.cjs"],
		languageOptions: {
			sourceType: "commonjs",
			globals: { require: "readonly", module: "writable", process: "readonly", __dirname: "readonly", console: "readonly", Buffer: "readonly", setTimeout: "readonly", clearTimeout: "readonly" },
		},
		rules: {
			"obsidianmd/rule-custom-message": "off",
			// A Node CLI, not plugin code: Obsidian's in-app rules don't apply.
			"obsidianmd/no-nodejs-modules": "off",
			"obsidianmd/prefer-window-timers": "off",
			"obsidianmd/hardcoded-config-path": "off",
			"no-implicit-globals": "off",
			"@typescript-eslint/no-require-imports": "off",
			"no-empty": ["error", { allowEmptyCatch: true }],
			// Browser globals from the shared config don't exist in Node.
			"no-redeclare": ["error", { builtinGlobals: false }],
		},
	},
	{
		files: ["src/**/*.ts", "tests/**/*.ts"],
		rules: {
			"no-var": "error",
			"@typescript-eslint/no-explicit-any": "error",
		},
	},
	{
		// node:test's test()/describe() return promises that the runner collects
		files: ["tests/**/*.ts"],
		rules: { "@typescript-eslint/no-floating-promises": "off" },
	},
	{
		files: ["src/**/*.ts"],
		rules: {
			"no-restricted-imports": ["error", { paths: nodeOnly, patterns: [nodeColon] }],
		},
	},
	{
		// core must stay pure: no obsidian (@codemirror/state is allowed)
		files: ["src/core/**/*.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					paths: [
						...nodeOnly,
						{ name: "obsidian", message: "src/core must be pure; do not import obsidian." },
					],
					patterns: [nodeColon, { group: ["obsidian/*"], message: "src/core must be pure." }],
				},
			],
		},
	},
]);
