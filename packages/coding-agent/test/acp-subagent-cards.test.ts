import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { SessionNotification } from "@oh-my-pi/pi-utils/acp";
import { SubagentCardTracker } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-subagent-cards";
import { buildTaskCallTitle, buildTaskResultSummary } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-subagent-cards";
import {
	buildToolCallStartUpdate,
	mapAgentSessionEventToAcpSessionUpdates,
} from "@oh-my-pi/pi-coding-agent/modes/acp/acp-event-mapper";
import { expectAcpStructure } from "./helpers/acp-schema";

const arkSessionNotification = type({
	sessionId: "string",
	update: {
		sessionUpdate:
			"'agent_thought_chunk' | 'agent_message_chunk' | 'tool_call' | 'tool_call_update' | 'plan' | 'plan_update' | 'available_commands_update' | 'current_mode_update' | 'config_option_update' | 'session_info_update' | 'usage_update'",
	},
});

function expectAcpNotifications(updates: SessionNotification[]): void {
	for (const update of updates) {
		expectAcpStructure(arkSessionNotification, update);
	}
}

function updates(updatesList: SessionNotification[]): unknown[] {
	return updatesList.map(notification => notification.update);
}

function progressRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "ag-1",
		agent: "scout",
		status: "running",
		task: "Research configs",
		stage: "reading files",
		toolCount: 3,
		tokens: 4200,
		recentOutput: ["grep -rn model src/", "found 4 hits"],
		...overrides,
	};
}

function resultRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "ag-1",
		agent: "scout",
		task: "Research configs",
		exitCode: 0,
		output: "Found 4 model definitions in src/config.",
		tokens: 12345,
		durationMs: 192_000,
		truncated: false,
		...overrides,
	};
}

const SESSION = "sess-test";

describe("SubagentCardTracker", () => {
	it("creates one card per subagent progress row", () => {
		const tracker = new SubagentCardTracker();
		const notifications = tracker.sync(SESSION, [
			progressRow(),
			progressRow({ id: "ag-2", agent: "planner", stage: undefined }),
		]);
		expectAcpNotifications(notifications);
		const created = updates(notifications) as Array<Record<string, unknown>>;
		expect(created).toHaveLength(2);
		expect(created[0].sessionUpdate).toBe("tool_call");
		expect(created[0].toolCallId).toBe("subagent:ag-1");
		expect(created[0].name).toBe("agent");
		expect(created[0].kind).toBe("other");
		expect(created[0].status).toBe("in_progress");
		expect(created[0].title).toBe("scout — reading files (3 tools · 4.2k tok)");
		expect(created[1].toolCallId).toBe("subagent:ag-2");
	});

	it("does not re-emit unchanged rows", () => {
		const tracker = new SubagentCardTracker();
		tracker.sync(SESSION, [progressRow()]);
		const repeat = tracker.sync(SESSION, [progressRow()]);
		expect(repeat).toHaveLength(0);
	});

	it("emits an update when the stage line changes", () => {
		const tracker = new SubagentCardTracker();
		tracker.sync(SESSION, [progressRow()]);
		const notifications = tracker.sync(SESSION, [progressRow({ stage: "summarizing findings", toolCount: 9 })]);
		expectAcpNotifications(notifications);
		const updated = updates(notifications) as Array<Record<string, unknown>>;
		expect(updated).toHaveLength(1);
		expect(updated[0].sessionUpdate).toBe("tool_call_update");
		expect(updated[0].title).toBe("scout — summarizing findings (9 tools · 4.2k tok)");
		expect(updated[0].status).toBe("in_progress");
	});

	it("marks a retried subagent in the title", () => {
		const tracker = new SubagentCardTracker();
		const notifications = tracker.sync(SESSION, [
			progressRow({ retryState: { attempt: 2, maxAttempts: 5, errorMessage: "429 rate limited" } }),
		]);
		const created = updates(notifications) as Array<Record<string, unknown>>;
		expect(created[0].title).toBe("scout — retry 2/5: 429 rate limited");
	});

	it("finalizes cards from result rows, including unknown ids", () => {
		const tracker = new SubagentCardTracker();
		const notifications = tracker.finalizeFromResults(SESSION, [
			resultRow(),
			resultRow({ id: "ag-9", agent: "worker", exitCode: 1, error: "spawn failed" }),
		]);
		expectAcpNotifications(notifications);
		const settled = updates(notifications) as Array<Record<string, unknown>>;
		expect(settled).toHaveLength(2);
		expect(settled[0].sessionUpdate).toBe("tool_call");
		expect(settled[0].status).toBe("completed");
		expect(settled[0].title).toBe("scout — done 3m12s · 12.3k tok");
		expect(settled[1].status).toBe("failed");
		expect(settled[1].title).toBe("worker — failed: spawn failed");
	});

	it("aborts live cards on session cancel and resurrects on later progress", () => {
		const tracker = new SubagentCardTracker();
		tracker.sync(SESSION, [progressRow()]);
		const cancelled = tracker.abortAll(SESSION) as Array<SessionNotification>;
		expectAcpNotifications(cancelled);
		const aborted = updates(cancelled) as Array<Record<string, unknown>>;
		expect(aborted[0].status).toBe("failed");
		expect(aborted[0].title).toBe("scout — cancelled");

		const resurrected = tracker.sync(SESSION, [progressRow()]);
		const revived = updates(resurrected) as Array<Record<string, unknown>>;
		expect(revived[0].status).toBe("in_progress");
	});

	it("marks still-running cards as background at turn end", () => {
		const tracker = new SubagentCardTracker();
		tracker.sync(SESSION, [progressRow()]);
		const notifications = tracker.finalizeTurn(SESSION);
		const marked = updates(notifications) as Array<Record<string, unknown>>;
		expect(marked[0].sessionUpdate).toBe("tool_call_update");
		expect(marked[0].title).toBe("scout — reading files (3 tools · 4.2k tok) — background");
	});
});

describe("supervisor summary", () => {
	it("rolls up active subagents and ignores settled ones", () => {
		const tracker = new SubagentCardTracker();
		tracker.sync(SESSION, [
			progressRow(),
			progressRow({ id: "ag-2", agent: "planner", stage: "drafting", tokens: 600 }),
		]);
		expect(tracker.supervisorSummary()).toEqual({ active: 2, tokens: 4800, focus: "scout: reading files" });
		tracker.finalizeFromResults(SESSION, [resultRow(), resultRow({ id: "ag-2", agent: "planner" })]);
		expect(tracker.supervisorSummary()).toBeUndefined();
	});

	it("falls back to the task label when the stage is unknown", () => {
		const tracker = new SubagentCardTracker();
		tracker.sync(SESSION, [progressRow({ stage: undefined, lastIntent: undefined })]);
		expect(tracker.supervisorSummary()?.focus).toBe("scout: Research configs");
	});
});

describe("child-session mode (emitCards: false)", () => {
	it("updates state silently while the supervisor rollup stays live", () => {
		const tracker = new SubagentCardTracker({ emitCards: false });
		expect(tracker.sync(SESSION, [progressRow()])).toHaveLength(0);
		expect(tracker.supervisorSummary()).toEqual({ active: 1, tokens: 4200, focus: "scout: reading files" });
		expect(tracker.finalizeFromResults(SESSION, [resultRow()])).toHaveLength(0);
		expect(tracker.supervisorSummary()).toBeUndefined();
	});

	it("aborts state without emitting", () => {
		const tracker = new SubagentCardTracker({ emitCards: false });
		tracker.sync(SESSION, [progressRow()]);
		expect(tracker.abortAll(SESSION)).toHaveLength(0);
		expect(tracker.supervisorSummary()).toBeUndefined();
	});
});

describe("task call titles", () => {
	it("titles a flat spawn", () => {
		const update = buildToolCallStartUpdate({
			toolCallId: "call-1",
			toolName: "task",
			args: { agent: "scout", task: "Research the config layer\nsecond line" },
		}) as { title: string };
		expect(update.title).toBe("task: scout — Research the config layer");
	});

	it("titles the default agent without repeating 'task'", () => {
		expect(buildTaskCallTitle({ agent: "task", task: "Fix the flaky test" })).toBe("task: Fix the flaky test");
	});

	it("titles a batch spawn with the agent roster", () => {
		expect(
			buildTaskCallTitle({
				items: [
					{ agent: "scout", task: "a" },
					{ agent: "scout", task: "b" },
					{ agent: "planner", task: "c" },
				],
			}),
		).toBe("task ×3: scout, planner");
	});
});

describe("task result summary", () => {
	it("renders one line per agent plus a token rollup", () => {
		const summary = buildTaskResultSummary([
			resultRow(),
			resultRow({ id: "ag-2", agent: "worker", exitCode: 1, error: "boom", tokens: 0, durationMs: 0 }),
		]);
		expect(summary).toContain("✓ scout (3m12s · 12.3k tok)");
		expect(summary).toContain("✗ worker — boom");
		expect(summary).toContain("Σ 2 agents · 12.3k tok");
	});
});

describe("mapper routing", () => {
	it("task updates emit a status-only parent update plus per-subagent cards (no JSON blob)", () => {
		const tracker = new SubagentCardTracker();
		const notifications = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "task",
				args: { agent: "scout", task: "Research configs" },
				partialResult: { details: { progress: [progressRow()] } },
			},
			SESSION,
			{ subagentCards: tracker },
		);
		expectAcpNotifications(notifications);
		const frames = updates(notifications) as Array<Record<string, unknown>>;
		expect(frames).toHaveLength(2);
		expect(frames[0].sessionUpdate).toBe("tool_call_update");
		expect(frames[0].toolCallId).toBe("call-1");
		expect(frames[0].status).toBe("in_progress");
		// The parent card body must stay clean: the progress detail lives on the
		// subagent cards, never as serialized JSON.
		expect(frames[0].content).toBeUndefined();
		expect(frames[1].toolCallId).toBe("subagent:ag-1");
	});

	it("task end finalizes cards and replaces the result blob with a summary", () => {
		const tracker = new SubagentCardTracker();
		tracker.sync(SESSION, [progressRow()]);
		const notifications = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "task",
				isError: false,
				result: { content: [{ type: "text", text: "done" }], details: { results: [resultRow()] } },
			},
			SESSION,
			{ subagentCards: tracker },
		);
		expectAcpNotifications(notifications);
		const frames = updates(notifications) as Array<Record<string, unknown>>;
		expect(frames[0].toolCallId).toBe("call-1");
		expect(frames[0].status).toBe("completed");
		expect(frames[0].content).toHaveLength(1);
		const summary = (frames[0].content as Array<{ content: { text: string } }>)[0].content.text;
		expect(summary).toContain("✓ scout");
		expect(frames[1].toolCallId).toBe("subagent:ag-1");
		expect(frames[1].status).toBe("completed");
	});

	it("task end with background jobs keeps the parent card live", () => {
		const notifications = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "task",
				isError: false,
				result: {
					content: [],
					details: {
						results: [resultRow()],
						progress: [progressRow()],
						async: { state: "running", jobId: "job-1", type: "task" },
					},
				},
			},
			SESSION,
			{ subagentCards: new SubagentCardTracker() },
		);
		const frames = updates(notifications) as Array<Record<string, unknown>>;
		expect(frames[0].status).toBe("in_progress");
		const content = (frames[0].content as Array<{ content: { text: string } }>)[0].content.text;
		expect(content).toContain("Running in background (1 agents)");
	});

	it("wait frames refresh the live cards after the generic update", () => {
		const tracker = new SubagentCardTracker();
		const notifications = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "call-wait",
				toolName: "wait",
				args: {},
				partialResult: { details: { progress: [progressRow({ stage: "waiting on jobs" })] } },
			},
			SESSION,
			{ subagentCards: tracker },
		);
		expectAcpNotifications(notifications);
		const frames = updates(notifications) as Array<Record<string, unknown>>;
		expect(frames[0].toolCallId).toBe("call-wait");
		expect(frames[1].toolCallId).toBe("subagent:ag-1");
		expect(frames[1].title).toBe("scout — waiting on jobs (3 tools · 4.2k tok)");
	});
});
