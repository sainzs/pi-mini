/**
 * The child session's resource loader.
 *
 * This one object closes four holes at once, which is why it exists instead of a
 * pile of flags:
 *
 *  1. **The fork bomb.** Confirmed by execution: `createAgentSession()` with no
 *     `resourceLoader` runs `DefaultResourceLoader` discovery and loads *every*
 *     discovered extension — including this one. A summoned run would get the
 *     `mini` tool, summon grandchildren, and multiply at every level. Returning
 *     an explicit, closed extension set is the fix; a depth counter alone is not,
 *     because the tool would still be registered.
 *  2. **`AGENTS.md`.** `buildSystemPrompt` appends context files verbatim. In
 *     `~/pi-mono` that file is 11,226 bytes ≈ 2,800 tokens — larger than pi's
 *     system prompt and all seven tool schemas combined, re-read on every step.
 *     A summoned run gets a brief, not a repo constitution.
 *  3. **Harness chatter.** No skills, no prompt templates, no injected
 *     reminders — the property the whole design is trying to preserve.
 *  4. **Headless hangs.** Discovered extensions may call `ctx.ui.confirm()` on a
 *     dangerous tool call. In a nested session with no TUI attached that promise
 *     can never settle, hanging the run while it holds a concurrency slot.
 */

import type {
	Extension,
	ExtensionRuntime,
	LoadExtensionsResult,
	ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { createExtensionRuntime } from "@earendil-works/pi-coding-agent";

/** A single event handler injected into the child session. */
export interface InlineHandler {
	event: string;
	handler: (...args: unknown[]) => unknown;
}

/**
 * Build an `Extension` in memory.
 *
 * `loadExtensionFromFactory` exists in pi's source but is not re-exported from
 * `dist`, so we construct the record directly. `Extension` is a plain interface
 * of maps, so this is a structural fit rather than reaching into internals.
 */
function inlineExtension(name: string, handlers: InlineHandler[]): Extension {
	const handlerMap = new Map<string, Array<(...args: unknown[]) => unknown>>();
	for (const { event, handler } of handlers) {
		const existing = handlerMap.get(event) ?? [];
		existing.push(handler);
		handlerMap.set(event, existing);
	}

	return {
		path: name,
		resolvedPath: name,
		hidden: true,
		sourceInfo: { path: name, source: name, scope: "temporary", origin: "top-level" },
		handlers: handlerMap as Extension["handlers"],
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	} as Extension;
}

export interface MiniResourceLoaderInput {
	systemPrompt: string;
	/** Handlers injected into the child — in practice, the pre-spend budget gate. */
	handlers: InlineHandler[];
}

/**
 * A closed resource set: exactly the system prompt we wrote and exactly the
 * handlers we injected. Nothing is discovered from disk.
 */
export class MiniResourceLoader implements ResourceLoader {
	private readonly systemPrompt: string;
	private readonly extensionsResult: LoadExtensionsResult;

	constructor(input: MiniResourceLoaderInput) {
		this.systemPrompt = input.systemPrompt;
		const runtime: ExtensionRuntime = createExtensionRuntime();
		this.extensionsResult = {
			extensions: input.handlers.length ? [inlineExtension("<pi-mini:budget>", input.handlers)] : [],
			errors: [],
			runtime,
		};
	}

	getExtensions(): LoadExtensionsResult {
		return this.extensionsResult;
	}

	getSkills() {
		return { skills: [], diagnostics: [] };
	}

	getPrompts() {
		return { prompts: [], diagnostics: [] };
	}

	getThemes() {
		return { themes: [], diagnostics: [] };
	}

	/** No AGENTS.md / CLAUDE.md. See (2) above. */
	getAgentsFiles() {
		return { agentsFiles: [] };
	}

	getSystemPrompt(): string | undefined {
		return this.systemPrompt;
	}

	getSystemPromptSource(): { path: string } | undefined {
		return undefined;
	}

	getAppendSystemPrompt(): string[] {
		return [];
	}

	getAppendSystemPromptSources(): Array<{ path: string }> {
		return [];
	}

	/** Deliberately inert: a closed set cannot be extended from disk. */
	extendResources(): void {}

	async reload(): Promise<void> {}
}
