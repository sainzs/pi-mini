/**
 * Per-provider summon admission.
 *
 * The queue limits concurrent runs and spaces releases for rate-limited model
 * deployments. A bounded wait is intentional: availability wins over strict
 * throttling once a caller has waited too long.
 */

export interface ProviderQueueConfig {
	maxConcurrent: number;
	minGapMs: number;
}

export type ProviderQueueMatcher = RegExp | ((key: string) => boolean);

export interface ProviderQueueRule {
	matcher: ProviderQueueMatcher;
	config: ProviderQueueConfig;
}

export interface ProviderQueueOptions {
	defaultConfig?: Partial<ProviderQueueConfig>;
	rules?: readonly ProviderQueueRule[];
	maxWaitMs?: number;
}

interface Waiter {
	resolve: (release: () => void) => void;
	deadline: number;
	config: ProviderQueueConfig;
}

interface QueueState {
	active: number;
	lastReleasedAt?: number;
	waiters: Waiter[];
	timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_CONFIG: ProviderQueueConfig = { maxConcurrent: 2, minGapMs: 0 };
const DEFAULT_RULES: readonly ProviderQueueRule[] = [
	{
		matcher: /azure-foundry\/deepseek/i,
		config: { maxConcurrent: 1, minGapMs: 15_000 },
	},
];
const DEFAULT_MAX_WAIT_MS = 90_000;

function normalizeConfig(config: Partial<ProviderQueueConfig>, fallback: ProviderQueueConfig): ProviderQueueConfig {
	const maxConcurrent = config.maxConcurrent ?? fallback.maxConcurrent;
	const minGapMs = config.minGapMs ?? fallback.minGapMs;
	return {
		maxConcurrent: Number.isFinite(maxConcurrent) ? Math.max(1, Math.floor(maxConcurrent)) : fallback.maxConcurrent,
		minGapMs: Number.isFinite(minGapMs) ? Math.max(0, minGapMs) : fallback.minGapMs,
	};
}

function matches(matcher: ProviderQueueMatcher, key: string): boolean {
	if (matcher instanceof RegExp) {
		matcher.lastIndex = 0;
		return matcher.test(key);
	}
	return matcher(key);
}

export class ProviderQueue {
	private readonly defaultConfig: ProviderQueueConfig;
	private readonly rules: readonly ProviderQueueRule[];
	private readonly maxWaitMs: number;
	private readonly states = new Map<string, QueueState>();

	constructor(options: ProviderQueueOptions = {}) {
		this.defaultConfig = normalizeConfig(options.defaultConfig ?? {}, DEFAULT_CONFIG);
		this.rules = options.rules ?? DEFAULT_RULES;
		this.maxWaitMs =
			options.maxWaitMs !== undefined && Number.isFinite(options.maxWaitMs)
				? Math.max(0, options.maxWaitMs)
				: DEFAULT_MAX_WAIT_MS;
	}

	async acquire(key: string): Promise<() => void> {
		const state = this.states.get(key) ?? { active: 0, waiters: [] };
		this.states.set(key, state);
		const config = this.getConfig(key);
		const deadline = Date.now() + this.maxWaitMs;

		return new Promise<() => void>((resolve) => {
			state.waiters.push({ resolve, deadline, config });
			this.pump(key, state);
		});
	}

	private getConfig(key: string): ProviderQueueConfig {
		const rule = this.rules.find((candidate) => matches(candidate.matcher, key));
		return rule ? normalizeConfig(rule.config, this.defaultConfig) : this.defaultConfig;
	}

	private pump(key: string, state: QueueState): void {
		if (state.timer !== undefined) {
			clearTimeout(state.timer);
			state.timer = undefined;
		}

		while (state.waiters.length > 0) {
			const waiter = state.waiters[0];
			const now = Date.now();
			const gapReadyAt = state.lastReleasedAt === undefined
				? now
				: state.lastReleasedAt + waiter.config.minGapMs;
			const capacityReady = state.active < waiter.config.maxConcurrent;
			const gapReady = now >= gapReadyAt;

			if ((capacityReady && gapReady) || now >= waiter.deadline) {
				state.waiters.shift();
				state.active++;
				waiter.resolve(this.releaseFor(key, state));
				continue;
			}

			const wakeAt = Math.min(waiter.deadline, capacityReady ? gapReadyAt : waiter.deadline);
			state.timer = setTimeout(() => {
				state.timer = undefined;
				this.pump(key, state);
			}, Math.max(1, wakeAt - now));
			break;
		}
	}

	private releaseFor(key: string, state: QueueState): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			state.active--;
			state.lastReleasedAt = Date.now();
			this.pump(key, state);
		};
	}
}
