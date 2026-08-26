/**
 * /webui — control the Prime Agent mobile web UI from inside a session.
 *
 * A deliberately thin wrapper. Every decision about how the gateway starts,
 * which interface it binds, and how it is stopped lives in the
 * `prime-agent-mobile` CLI, and this shells out to it. Two implementations of
 * a process lifecycle would drift, and the one that drifted would be the one
 * nobody ran by hand.
 *
 * It never spawns the gateway itself. An extension runs inside a worker
 * process, and `prime-agent shutdown --force` terminates worker process groups
 * and their tracked children, so a gateway parented here would die with
 * whichever session happened to start it. The CLI detaches it instead.
 *
 * Install: copy to ~/.prime/agent/extensions/, or run
 * `prime-agent-mobile install-command`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLI = "prime-agent-mobile";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("webui", {
		description: "Prime Agent mobile web UI: status, start, stop, token",
		getArgumentCompletions: (prefix: string) => {
			const items = ["status", "start", "stop", "token"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const requested = args.trim().split(/\s+/u).filter(Boolean);
			const action = requested[0] ?? "status";
			if (!["status", "start", "stop", "token"].includes(action)) {
				ctx.ui.notify(`/webui: unknown action "${action}". Try status, start, stop or token.`, "error");
				return;
			}

			const run = async (argv: string[]) => {
				try {
					return await pi.exec(CLI, argv, { timeout: 120_000 });
				} catch (error) {
					return { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: 127 };
				}
			};

			let result = await run([action]);

			if (result.code === 127) {
				ctx.ui.notify(
					`/webui: \`${CLI}\` is not on PATH. Install the mobile web UI, or run its CLI from its checkout.`,
					"error",
				);
				return;
			}

			// `status` exits non-zero when nothing is running. Starting from
			// there is the whole point of asking, so it is the default path
			// rather than an error to report back.
			if (action === "status" && result.code !== 0) {
				ctx.ui.notify("Web UI is not running. Starting it...", "info");
				result = await run(["start"]);
			}

			const output = `${result.stdout}${result.stderr}`.trim();
			if (result.code !== 0) {
				ctx.ui.notify(output || `/webui ${action} failed.`, "error");
				return;
			}

			// The URL matters more than the rest: an agent that cannot name the
			// address serving its own UI is the documented way to end up
			// editing one thing, checking another, and reporting success.
			const url = output.match(/https?:\/\/\S+/u)?.[0];
			ctx.ui.notify(output || `/webui ${action} done.`, "info");
			if (url && action !== "stop") {
				ctx.ui.notify(
					`The mobile web UI is served from ${url}. Verify changes against that address; `
					+ "do not start a second server on another port.",
					"info",
				);
			}
		},
	});
}
