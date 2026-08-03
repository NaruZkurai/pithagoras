import { Type } from "typebox";
import { getDb, getDefaultReportTo, type ReportTo } from "../db.js";
import { channelSupervisor } from "../channels/supervisor.js";
import type { RoutineRow } from "../routines/supervisor.js";

/**
 * Reporting back from a routine.
 *
 * A routine runs with nobody watching: its account of what it did lands in
 * `last_output`, which is only seen by someone who goes looking. This is the
 * way out — the agent decides a run is worth telling you about and says so
 * through a channel you already use.
 *
 * The agent chooses *whether* and *what*; it does not choose *where*. The
 * destination is configuration, so a routine cannot start messaging somewhere
 * it was never pointed at.
 */

/**
 * A routine's own destination, or the portal default.
 *
 * NULL inherits. An empty string is an explicit "this one never reports", which
 * is why it is distinguished from NULL rather than treated as unset.
 */
export function reportToFor(slug: string | null | undefined): ReportTo | null {
  if (!slug) return getDefaultReportTo();
  const row = getDb().prepare("SELECT * FROM routines WHERE slug = ?").get(slug) as
    | RoutineRow
    | undefined;
  if (!row) return getDefaultReportTo();
  if (row.report_channel === "") return null;
  if (row.report_channel && row.report_target) {
    return { channel: row.report_channel, target: row.report_target };
  }
  return getDefaultReportTo();
}

/** What the routine prompt says about reporting, or nothing when it cannot. */
export function reportFraming(to: ReportTo | null): string {
  if (!to) return "";
  return [
    `You can reach a human through the "${to.channel}" channel with the report tool.`,
    "Use it when there is something worth knowing — what you found, what you changed,",
    "anything that needs a decision. Skip it when the run was uneventful; a report",
    "that says nothing happened trains people to ignore the next one.",
  ].join("\n");
}

/** An ExtensionFactory — see pi's InlineExtension. */
export function reportTool(routineSlug: string | null) {
  return (pi: any): void => {
    pi.registerTool({
      name: "report",
      label: "Report back",
      description:
        "Send a message to the human who set this routine up, through the channel it reports to. " +
        "Use it for something worth their attention: what you found, what you changed, a decision " +
        "you need. It is one-way — you will not get a reply, so do not ask questions.",
      promptSnippet: "report — tell the human something worth knowing about this run",
      parameters: Type.Object({
        message: Type.String({ description: "What to say. Written for someone who was not here." }),
      }),
      async execute(_id: string, p: any) {
        const to = reportToFor(routineSlug);
        if (!to) return { output: "Nowhere to report to — no destination is configured.", isError: true };
        const message = String(p.message ?? "").trim();
        if (!message) return { output: "Nothing to send.", isError: true };
        try {
          await channelSupervisor.send(to.channel, to.target, message);
          return { output: `Sent to ${to.channel}.`, isError: false };
        } catch (e) {
          return { output: `Could not send: ${(e as Error).message}`, isError: true };
        }
      },
    });
  };
}
