import type { SessionNotification, SessionUpdate, ToolCallStatus } from "@oh-my-pi/pi-utils/acp";

/**
 * Live per-subagent ACP cards for `task` runs — the editor-side stand-in for the
 * TUI's Agent Hub rows.
 *
 * The task tool fans out subagents whose progress reaches the parent session as
 * `tool_execution_update` frames carrying `AgentProgress[]` rows in
 * `details.progress`, and their settlements as `SingleResult[]` rows in
 * `details.results`. Without help those rows serialize to an opaque JSON blob in
 * ACP clients. The tracker turns each row (keyed by the subagent's stable id)
 * into its own tool_call card (`toolCallId: "subagent:<id>"`) with a live title
 * (stage / intent / retry state), a small output tail, and honest settlement
 * status — so a Zed user sees one card per subagent session, in order, with
 * duration/token/cost attribution on completion.
 */

const CARD_ID_PREFIX = "subagent:";
const CARD_TEXT_LIMIT = 1_500;
const TITLE_LIMIT = 120;
const OUTPUT_TAIL_LINES = 6;

export type SubagentCardStatus = ToolCallStatus;

/** Structural subset of pi-tui's `AgentProgress` the cards renderer relies on. */
export interface SubagentProgressRow {
	id?: unknown;
	agent?: unknown;
	status?: unknown;
	task?: unknown;
	assignment?: unknown;
	description?: unknown;
	lastIntent?: unknown;
	stage?: unknown;
	currentTool?: unknown;
	currentToolArgs?: unknown;
	currentToolIntent?: unknown;
	recentOutput?: unknown;
	toolCount?: unknown;
	tokens?: unknown;
	cost?: unknown;
	durationMs?: unknown;
	retryState?: unknown;
	retryFailure?: unknown;
}

/** Structural subset of pi-tui's `SingleResult`. */
export interface SubagentResultRow {
	id?: unknown;
	index?: unknown;
	agent?: unknown;
	task?: unknown;
	assignment?: unknown;
	description?: unknown;
	output?: unknown;
	stderr?: unknown;
	truncated?: unknown;
	exitCode?: unknown;
	tokens?: unknown;
	cost?: unknown;
	durationMs?: unknown;
	error?: unknown;
	aborted?: unknown;
	retryFailure?: unknown;
}

interface SubagentCard {
	toolCallId: string;
	parentToolCallId: string | undefined;
	agent: string;
	label: string;
	status: SubagentCardStatus;
	created: boolean;
	lastTitle: string | undefined;
	/** Latest live detail for the supervisor title (`focus` line). */
	stage: string | undefined;
	tokens: number | undefined;
}

/**
 * Track per-session subagent cards. One instance per managed ACP session; the
 * mapper routes `task`/`wait` progress through {@linkcode sync} and settlements
 * through {@linkcode finalizeFromResults}.
 */
export class SubagentCardTracker {
	#cards = new Map<string, SubagentCard>();

	/** Non-terminal card count (running or queued subagents). */
	get activeCount(): number {
		let count = 0;
		for (const card of this.#cards.values()) {
			if (!isTerminalStatus(card.status)) count++;
		}
		return count;
	}

	/**
	 * Live rollup for the supervisor channel (the thread title in the editor's
	 * session list): how many subagents run, their combined token burn, and the
	 * focus line of the first active subagent. `undefined` when nothing runs.
	 */
	supervisorSummary(): { active: number; tokens: number; focus: string } | undefined {
		let active = 0;
		let tokens = 0;
		let focus: string | undefined;
		for (const card of this.#cards.values()) {
			if (isTerminalStatus(card.status)) continue;
			active++;
			tokens += card.tokens ?? 0;
			focus ??= `${card.agent}: ${card.stage ?? card.label}`;
		}
		if (active === 0) return undefined;
		return { active, tokens, focus: clipTitle(focus ?? "subagents") };
	}

	/**
	 * Upsert cards from live progress rows. A card already in a terminal state is
	 * resurrected only by a non-terminal row (a background job can outlive a
	 * session cancel and keep reporting); terminal rows never rewrite an earlier
	 * terminal state.
	 */
	sync(sessionId: string, rows: SubagentProgressRow[], parentToolCallId?: string): SessionNotification[] {
		const notifications: SessionNotification[] = [];
		for (const row of rows) {
			const id = asString(row.id);
			if (!id) continue;
			const nextStatus = statusFromRow(row);
			let card = this.#cards.get(id);
			if (!card) {
				card = {
					toolCallId: cardToolCallId(id),
					parentToolCallId,
					agent: asString(row.agent) ?? "agent",
					label: rowLabel(row),
					status: nextStatus,
					created: false,
					lastTitle: undefined,
					stage: asString(row.stage) ?? asString(row.lastIntent),
					tokens: asNumber(row.tokens),
				};
				this.#cards.set(id, card);
			} else {
				if (parentToolCallId && !card.parentToolCallId) card.parentToolCallId = parentToolCallId;
				if (isTerminalStatus(card.status)) {
					if (isTerminalStatus(nextStatus)) continue;
				}
				card.status = nextStatus;
				card.stage = asString(row.stage) ?? asString(row.lastIntent);
				card.tokens = asNumber(row.tokens);
			}
			const title = buildRunningTitle(card, row);
			if (!card.created) {
				card.created = true;
				card.lastTitle = title;
				notifications.push(toNotification(sessionId, buildCardCreate(card, row)));
			} else if (title !== card.lastTitle) {
				card.lastTitle = title;
				notifications.push(toNotification(sessionId, buildCardUpdate(card, title, row)));
			}
		}
		return notifications;
	}

	/**
	 * Settle cards from `SingleResult[]` rows of a finished task call. Unknown ids
	 * create their card directly in the settled state (history replay has no live
	 * progress frames, only the final result).
	 */
	finalizeFromResults(sessionId: string, results: SubagentResultRow[]): SessionNotification[] {
		const notifications: SessionNotification[] = [];
		for (const [position, row] of results.entries()) {
			const id = asString(row.id) ?? `index-${asString(row.index) ?? position}`;
			const agent = asString(row.agent) ?? this.#cards.get(id)?.agent ?? "agent";
			const status = resultStatus(row);
			let card = this.#cards.get(id);
			if (!card) {
				card = {
					toolCallId: cardToolCallId(id),
					parentToolCallId: undefined,
					agent,
					label: resultLabel(row),
					status,
					created: false,
					lastTitle: undefined,
					stage: undefined,
					tokens: asNumber(row.tokens),
				};
				this.#cards.set(id, card);
			} else {
				card.status = status;
			}
			const title = buildResultTitle(card, row, status);
			if (!card.created) {
				card.created = true;
				card.lastTitle = title;
				notifications.push(toNotification(sessionId, buildCardCreate(card, row)));
			} else {
				card.lastTitle = title;
				notifications.push(toNotification(sessionId, buildCardUpdate(card, title, row)));
			}
		}
		return notifications;
	}

	/**
	 * Turn boundary: subagents still running (background async jobs) keep their
	 * in_progress status — the work is genuinely alive — but the title gains a
	 * marker so the card reads as "running outside the current turn".
	 */
	finalizeTurn(sessionId: string): SessionNotification[] {
		const notifications: SessionNotification[] = [];
		for (const card of this.#cards.values()) {
			if (isTerminalStatus(card.status) || !card.created) continue;
			const marker = " — background";
			if (card.lastTitle && !card.lastTitle.endsWith(marker)) {
				const title = clipTitle(`${card.lastTitle}${marker}`);
				card.lastTitle = title;
				notifications.push(
					toNotification(sessionId, { sessionUpdate: "tool_call_update", toolCallId: card.toolCallId, title }),
				);
			}
		}
		return notifications;
	}

	/** Fail every non-terminal card spawned by one parent task call (spawn failure, abort). */
	failParent(sessionId: string, parentToolCallId: string, reason: string): SessionNotification[] {
		const notifications: SessionNotification[] = [];
		for (const card of this.#cards.values()) {
			if (card.parentToolCallId !== parentToolCallId || isTerminalStatus(card.status)) continue;
			card.status = "failed";
			const title = clipTitle(`${card.agent} — failed: ${clipText(reason, 60)}`);
			card.lastTitle = title;
			notifications.push(
				toNotification(sessionId, {
					sessionUpdate: "tool_call_update",
					toolCallId: card.toolCallId,
					status: "failed",
					title,
					content: [{ type: "content", content: { type: "text", text: reason } }],
				}),
			);
		}
		return notifications;
	}

	/**
	 * Session cancel: every non-terminal card reads "cancelled" until proven
	 * otherwise — a background job that survives the cancel resurrects its card
	 * on the next progress row (see {@linkcode sync}).
	 */
	abortAll(sessionId: string): SessionNotification[] {
		const notifications: SessionNotification[] = [];
		for (const card of this.#cards.values()) {
			if (isTerminalStatus(card.status) || !card.created) continue;
			card.status = "failed";
			const title = clipTitle(`${card.agent} — cancelled`);
			card.lastTitle = title;
			notifications.push(
				toNotification(sessionId, {
					sessionUpdate: "tool_call_update",
					toolCallId: card.toolCallId,
					status: "failed",
					title,
				}),
			);
		}
		return notifications;
	}
}

/** Extract `AgentProgress[]` rows from a task/wait tool frame (`details.progress`, top-level fallback). */
export function extractSubagentProgressRows(value: unknown): SubagentProgressRow[] {
	const progress = readContainer(value)?.progress;
	return isObjectArray(progress) ? (progress as SubagentProgressRow[]) : [];
}

/** Extract `SingleResult[]` rows from a settled task result (`details.results`). */
export function extractSubagentResultRows(value: unknown): SubagentResultRow[] {
	const results = readContainer(value)?.results;
	return isObjectArray(results) ? (results as SubagentResultRow[]) : [];
}

/** Extract the background-job state (`details.async.state`) of a task frame. */
export function extractSubagentAsyncState(value: unknown): string | undefined {
	return asString(asRecord(readContainer(value)?.async)?.state);
}

/**
 * Title for a `task` tool call card: `task: scout — fix the flaky test` for a
 * flat spawn, `task ×3: scout, planner, worker` for a batch spawn. `undefined`
 * when the args carry nothing recognizable (generic title path takes over).
 */
export function buildTaskCallTitle(args: unknown): string | undefined {
	if (!isRecord(args)) return undefined;
	const items = args.items;
	if (Array.isArray(items) && items.length > 0) {
		const agents = new Set<string>();
		for (const item of items) {
			const agent = isRecord(item) ? asString(item.agent) : undefined;
			if (agent) agents.add(agent);
		}
		const agentsLabel = agents.size > 0 ? [...agents].join(", ") : "agents";
		return clipTitle(`task ×${items.length}: ${agentsLabel}`);
	}
	const agent = asString(args.agent);
	const taskLine = firstLine(asString(args.task)) ?? firstLine(asString(args.description));
	if (!taskLine) return agent ? clipTitle(`task: ${agent}`) : undefined;
	// The schema default agent is literally named "task" — "task: task — …" reads twice.
	const agentLabel = agent && agent !== "task" ? `: ${agent} — ` : ": ";
	return clipTitle(`task${agentLabel}${taskLine}`);
}

/** One-line-per-subagent summary replacing the JSON blob the generic path would render. */
export function buildTaskResultSummary(results: SubagentResultRow[]): string {
	const lines: string[] = [];
	let totalTokens = 0;
	for (const row of results) {
		const status = resultStatus(row);
		const agent = asString(row.agent) ?? "agent";
		const metrics: string[] = [];
		const duration = fmtDuration(asNumber(row.durationMs));
		if (duration) metrics.push(duration);
		const tokens = asNumber(row.tokens);
		if (tokens !== undefined && tokens > 0) {
			totalTokens += tokens;
			metrics.push(`${fmtTokens(tokens)} tok`);
		}
		const cost = asNumber(row.cost);
		if (cost !== undefined && cost > 0) metrics.push(fmtCost(cost));
		const failure = resultFailureText(row);
		const detail = metrics.length > 0 ? ` (${metrics.join(" · ")})` : "";
		lines.push(
			status === "completed" ? `✓ ${agent}${detail}` : `✗ ${agent}${detail}${failure ? ` — ${failure}` : ""}`,
		);
	}
	const suffix = totalTokens > 0 ? ` · ${fmtTokens(totalTokens)} tok` : "";
	lines.push(`Σ ${results.length} ${results.length === 1 ? "agent" : "agents"}${suffix}`);
	return clipText(lines.join("\n"), 2_000);
}

function buildCardCreate(card: SubagentCard, row: SubagentProgressRow | SubagentResultRow): SessionUpdate {
	const update: SessionUpdate = {
		sessionUpdate: "tool_call",
		toolCallId: card.toolCallId,
		name: "agent",
		title: card.lastTitle ?? cardTitle(card),
		kind: "other",
		status: card.status,
		rawInput: { agent: card.agent, task: card.label },
		content: [{ type: "content", content: { type: "text", text: cardContent(card, row) } }],
	};
	return update;
}

function buildCardUpdate(
	card: SubagentCard,
	title: string,
	row: SubagentProgressRow | SubagentResultRow,
): SessionUpdate {
	const update: SessionUpdate = {
		sessionUpdate: "tool_call_update",
		toolCallId: card.toolCallId,
		status: card.status,
		title,
		content: [{ type: "content", content: { type: "text", text: cardContent(card, row) } }],
	};
	return update;
}

function cardTitle(card: SubagentCard): string {
	return clipTitle(`${card.agent} — ${card.label}`);
}

function cardContent(card: SubagentCard, row: SubagentProgressRow | SubagentResultRow): string {
	const lines: string[] = [];
	const resultRow = row as SubagentResultRow;
	const output = asString(resultRow.output) ?? asString(resultRow.stderr);
	if (output !== undefined) {
		lines.push(tailText(output, CARD_TEXT_LIMIT, asBoolean(resultRow.truncated)));
	} else {
		const progressRow = row as SubagentProgressRow;
		const brief = asString(progressRow.stage) ?? asString(progressRow.description) ?? card.label;
		lines.push(brief);
		const tool = asString(progressRow.currentTool);
		if (tool) {
			const intent = asString(progressRow.currentToolIntent) ?? asString(progressRow.lastIntent);
			lines.push(`tool: ${tool}${intent ? ` — ${clipText(intent, 80)}` : ""}`);
		}
		const tail = tailLines(progressRow.recentOutput);
		if (tail) {
			lines.push("", tail);
		}
	}
	return clipText(lines.join("\n"), CARD_TEXT_LIMIT);
}

function buildRunningTitle(card: SubagentCard, row: SubagentProgressRow): string {
	const retry = asRecord(row.retryFailure) ?? asRecord(row.retryState);
	if (retry) {
		const attempt = asNumber(retry.attempt);
		const max = asNumber(retry.maxAttempts);
		const error = clipText(asString(retry.errorMessage) ?? "provider error", 40);
		const attemptLabel = attempt !== undefined ? `retry ${attempt}${max !== undefined ? `/${max}` : ""}` : "retrying";
		return clipTitle(`${card.agent} — ${attemptLabel}: ${error}`);
	}
	const step = asString(row.stage) ?? asString(row.lastIntent);
	const metrics: string[] = [];
	const toolCount = asNumber(row.toolCount);
	if (toolCount !== undefined && toolCount > 0) metrics.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
	const tokens = asNumber(row.tokens);
	if (tokens !== undefined && tokens > 0) metrics.push(`${fmtTokens(tokens)} tok`);
	const cost = asNumber(row.cost);
	if (cost !== undefined && cost > 0) metrics.push(fmtCost(cost));
	const metricsLabel = metrics.length > 0 ? ` (${metrics.join(" · ")})` : "";
	return clipTitle(`${card.agent} — ${step ?? card.label}${metricsLabel}`);
}

function buildResultTitle(card: SubagentCard, row: SubagentResultRow, status: SubagentCardStatus): string {
	if (status === "failed") {
		const failure = resultFailureText(row);
		return clipTitle(`${card.agent} — failed${failure ? `: ${clipText(failure, 60)}` : ""}`);
	}
	const metrics: string[] = [];
	const duration = fmtDuration(asNumber(row.durationMs));
	if (duration) metrics.push(duration);
	const tokens = asNumber(row.tokens);
	if (tokens !== undefined && tokens > 0) metrics.push(`${fmtTokens(tokens)} tok`);
	const cost = asNumber(row.cost);
	if (cost !== undefined && cost > 0) metrics.push(fmtCost(cost));
	const metricsLabel = metrics.length > 0 ? ` ${metrics.join(" · ")}` : "";
	return clipTitle(`${card.agent} — done${metricsLabel}`);
}

function statusFromRow(row: SubagentProgressRow): SubagentCardStatus {
	switch (asString(row.status)) {
		case "pending":
			return "pending";
		case "completed":
			return "completed";
		case "failed":
		case "aborted":
			return "failed";
		default:
			return "in_progress";
	}
}

function resultStatus(row: SubagentResultRow): SubagentCardStatus {
	if (asBoolean(row.aborted) || asRecord(row.retryFailure) || asString(row.error)) return "failed";
	if (asNumber(row.exitCode) === 0) return "completed";
	if (asString(row.output) !== undefined && asNumber(row.exitCode) === undefined) return "completed";
	return "failed";
}

function resultFailureText(row: SubagentResultRow): string | undefined {
	const retry = asRecord(row.retryFailure);
	const retryError = retry ? asString(retry.errorMessage) : undefined;
	return asString(retryError) ?? asString(row.error) ?? firstLine(asString(row.stderr));
}

function rowLabel(row: SubagentProgressRow): string {
	return (
		firstLine(asString(row.task)) ??
		firstLine(asString(row.assignment)) ??
		firstLine(asString(row.description)) ??
		"subagent"
	);
}

function resultLabel(row: SubagentResultRow): string {
	return (
		firstLine(asString(row.task)) ??
		firstLine(asString(row.assignment)) ??
		firstLine(asString(row.description)) ??
		"subagent"
	);
}

function cardToolCallId(id: string): string {
	return `${CARD_ID_PREFIX}${id}`;
}

function isTerminalStatus(status: SubagentCardStatus): boolean {
	return status === "completed" || status === "failed";
}

function toNotification(sessionId: string, update: SessionUpdate): SessionNotification {
	return { sessionId, update };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function isObjectArray(value: unknown): boolean {
	return Array.isArray(value) && value.length > 0 && value.every(isRecord);
}

interface ProgressContainer {
	progress?: unknown;
	results?: unknown;
	async?: { state?: unknown };
}

function readContainer(value: unknown): ProgressContainer | undefined {
	const details = asRecord(value)?.details ?? value;
	return asRecord(details) as ProgressContainer | undefined;
}

function firstLine(text: string | undefined): string | undefined {
	const line = text?.split("\n", 1)[0]?.trim();
	return line && line.length > 0 ? line : undefined;
}

function clipText(text: string, limit: number): string {
	const single = text.replace(/\r/g, "");
	return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

function clipTitle(text: string): string {
	return clipText(text, TITLE_LIMIT);
}

/** Keep the tail of a long output, marking the elided head. */
function tailText(text: string, limit: number, _sourceTruncated: boolean | undefined): string {
	const single = text.replace(/\r/g, "");
	if (single.length <= limit) return single;
	return `…${single.slice(single.length - limit + 1)}`;
}

function tailLines(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	const lines = value.filter((line): line is string => typeof line === "string" && line.trim().length > 0);
	if (lines.length === 0) return undefined;
	return lines.slice(-OUTPUT_TAIL_LINES).join("\n");
}

function fmtDuration(ms: number | undefined): string | undefined {
	if (ms === undefined || ms <= 0) return undefined;
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatTokens(tokens: number): string {
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${tokens}`;
}

const fmtTokens = formatTokens;

function fmtCost(cost: number): string {
	return `$${cost >= 1 ? cost.toFixed(2) : cost.toFixed(3)}`;
}
