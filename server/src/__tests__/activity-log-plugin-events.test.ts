/**
 * The activity log is the only place a plugin event is born, and an action that
 * is in neither `PLUGIN_EVENT_TYPES` nor the alias table is written to the log
 * and reaches no subscriber at all. That is a silent failure — nothing throws,
 * nothing warns, the plugin simply never fires — so the mapping needs a test
 * that goes all the way through the bus rather than reading the table back.
 *
 * The specific hole this covers: an agent handing a task to a human opens an
 * issue-thread interaction (it may not park the task and name a person as the
 * unblock owner — that is a 403), and before `issue.interaction.created` that
 * hand-off produced no plugin event on any surface.
 */
import { describe, expect, it } from "vitest";
import { activityLog, companies, instanceSettings, issues, type Db } from "@paperclipai/db";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { logActivity, setPluginEventBus } from "../services/activity-log.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const issueId = "00000000-0000-4000-8000-000000000003";
const interactionId = "00000000-0000-4000-8000-000000000008";

/**
 * Enough of a `Db` for `logActivity`: the instance-settings read behind the
 * redactor, the responsible-user lookups, and the insert. Deliberately not a
 * real database — what is under test is which event comes out, not what lands
 * in a table.
 */
function stubDb(): Db {
  const rowsByTable = new Map<unknown, Array<Record<string, unknown>>>([
    [instanceSettings, [{ id: "settings-1", general: {}, experimental: {} }]],
    [issues, []],
    [companies, []],
  ]);
  return {
    select: () => ({
      from: (table: unknown) => {
        const result = Promise.resolve(rowsByTable.get(table) ?? []);
        return {
          where: () => result,
          then: result.then.bind(result),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: () => ({
        returning: () => {
          expect(table).toBe(activityLog);
          return Promise.resolve([{ id: "activity-1" }]);
        },
      }),
    }),
  } as unknown as Db;
}

/**
 * The bus is emitted to fire-and-forget from `publishPluginDomainEvent`, so a
 * turn of the macrotask queue is what makes the delivery observable.
 */
async function eventsFor(action: string, details: Record<string, unknown>): Promise<PluginEvent[]> {
  const bus = createPluginEventBus();
  setPluginEventBus(bus);
  const received: PluginEvent[] = [];
  bus.forPlugin("test-subscriber").subscribe("issue.interaction.created", async (event) => {
    received.push(event);
  });
  bus.forPlugin("test-subscriber").subscribe("issue.interaction.resolved", async (event) => {
    received.push(event);
  });

  await logActivity(stubDb(), {
    companyId,
    actorType: "agent",
    actorId: "agent-1",
    agentId: "agent-1",
    action,
    entityType: "issue",
    entityId: issueId,
    details,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return received;
}

const CREATED_DETAILS = {
  interactionId,
  interactionKind: "request_confirmation",
  interactionStatus: "pending",
  continuationPolicy: "wake_assignee",
  addresseeAgentId: null,
  requestedResolverPolicy: "board_only",
  effectiveResolverPolicy: "board_only",
};

describe("an agent's hand-off to a human reaches a plugin", () => {
  it("delivers a created interaction as issue.interaction.created", async () => {
    const received = await eventsFor("issue.thread_interaction_created", CREATED_DETAILS);
    expect(received).toHaveLength(1);
    expect(received[0].eventType).toBe("issue.interaction.created");
  });

  it("carries enough to act on: the task, the kind, and that it is pending", async () => {
    // A subscriber that cannot tell which task, or whether anyone still has to
    // answer, cannot do anything with the event.
    const [event] = await eventsFor("issue.thread_interaction_created", CREATED_DETAILS);
    expect(event.entityType).toBe("issue");
    expect(event.entityId).toBe(issueId);
    expect(event.companyId).toBe(companyId);
    expect(event.payload).toMatchObject({
      interactionId,
      interactionKind: "request_confirmation",
      interactionStatus: "pending",
      addresseeAgentId: null,
    });
  });

  it("keeps those fields through redaction", async () => {
    // None of them look like a credential, and the redactor is name-driven — but
    // it is the redactor that decides, so assert it rather than assume it.
    const [event] = await eventsFor("issue.thread_interaction_created", CREATED_DETAILS);
    expect(JSON.stringify(event.payload)).not.toContain("REDACTED");
  });
});

describe("every way an interaction ends is one event", () => {
  const endings = [
    ["issue.thread_interaction_accepted", "accepted"],
    ["issue.thread_interaction_rejected", "rejected"],
    ["issue.thread_interaction_answered", "answered"],
    ["issue.thread_interaction_withdrawn", "cancelled"],
    ["issue.thread_interaction_cancelled", "cancelled"],
    ["issue.thread_interaction_expired", "expired"],
  ] as const;

  for (const [action, status] of endings) {
    it(`delivers ${action} as issue.interaction.resolved`, async () => {
      const received = await eventsFor(action, { interactionId, interactionStatus: status });
      expect(received).toHaveLength(1);
      expect(received[0].eventType).toBe("issue.interaction.resolved");
      expect(received[0].payload).toMatchObject({ interactionStatus: status });
    });
  }

  it("delivers a partial verdict submission as resolved, still marked pending", async () => {
    // Collapsed into the same event on purpose; the status in the payload is
    // what says whether anybody is off the hook.
    const received = await eventsFor("issue.thread_interaction_item_verdicts_submitted", {
      interactionId,
      interactionStatus: "pending",
      complete: false,
    });
    expect(received).toHaveLength(1);
    expect(received[0].eventType).toBe("issue.interaction.resolved");
    expect(received[0].payload).toMatchObject({ interactionStatus: "pending", complete: false });
  });
});

describe("nothing else changed shape", () => {
  it("still routes an approval decision to approval.decided", async () => {
    const bus = createPluginEventBus();
    setPluginEventBus(bus);
    const received: PluginEvent[] = [];
    bus.forPlugin("test-subscriber").subscribe("approval.decided", async (event) => {
      received.push(event);
    });
    await logActivity(stubDb(), {
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "approval.approved",
      entityType: "approval",
      entityId: "00000000-0000-4000-8000-000000000009",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received.map((event) => event.eventType)).toEqual(["approval.decided"]);
  });

  it("leaves an unmapped action off the bus entirely", async () => {
    const bus = createPluginEventBus();
    setPluginEventBus(bus);
    const received: PluginEvent[] = [];
    bus.forPlugin("test-subscriber").subscribe("issue.interaction.created", async (event) => {
      received.push(event);
    });
    await logActivity(stubDb(), {
      companyId,
      actorType: "agent",
      actorId: "agent-1",
      action: "issue.thread_interaction_reminded",
      entityType: "issue",
      entityId: issueId,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual([]);
  });
});
