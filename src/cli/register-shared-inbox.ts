import type { CliCommandContext } from "./command-context";
import {
	getSharedInboxSettings,
	listSharedInbox,
	sharedInboxFilterSchema,
	sharedInboxMutationSchema,
	sharedInboxSearchQuery,
	updateSharedInboxState,
	saveSharedInboxSettings,
} from "#/lib/shared-inbox";
import { sendSharedInboxHandoff } from "#/lib/shared-inbox-handoff";
import { syncTweetSearch } from "#/lib/tweet-search-live";
export function registerSharedInboxCommands({
	program,
	print,
	asJson,
}: CliCommandContext) {
	const shared = program
		.command("shared-inbox")
		.description("Local shared OpenClaw/Peter mentions and durable triage");
	shared
		.command("list")
		.option("--target <target>", "all, openclaw, peter", "all")
		.option("--read <state>", "all, unread, read", "all")
		.option("--handled <state>", "all, open, handled", "all")
		.option("--classification <type>", "all, unclassified, bug, feature", "all")
		.option("--search <text>", "Literal local text search", "")
		.option("--offset <n>", "Pagination offset", "0")
		.option("--limit <n>", "Page size (1–100)", "30")
		.action((options) =>
			print(listSharedInbox(sharedInboxFilterSchema.parse(options)), asJson()),
		);
	for (const [name, kind, value] of [
		["read", "read", true],
		["unread", "read", false],
		["handle", "handled", true],
		["reopen", "handled", false],
	] as const) {
		shared.command(name + " <tweetId>").action((id: string) => {
			updateSharedInboxState(
				kind === "read" ? { kind, ids: [id], value } : { kind, id, value },
			);
			print({ ok: true, id, kind, value }, asJson());
		});
	}
	shared
		.command("classify <tweetId> <type>")
		.action((id: string, value: string) => {
			const action = sharedInboxMutationSchema.parse({
				kind: "classify",
				id,
				value,
			});
			if (action.kind === "classify") updateSharedInboxState(action);
			print({ ok: true, id, classification: value }, asJson());
		});
	shared
		.command("names")
		.option("--openclaw <names>", "Comma-separated literal OpenClaw names")
		.option("--peter <names>", "Comma-separated literal Peter names")
		.action((options) => {
			const settings = getSharedInboxSettings();
			for (const target of ["openclaw", "peter"] as const)
				if (options[target] !== undefined)
					settings[target] = String(options[target])
						.split(",")
						.map((name) => name.trim())
						.filter(Boolean);
			print(
				options.openclaw !== undefined || options.peter !== undefined
					? saveSharedInboxSettings(settings)
					: settings,
				asJson(),
			);
		});
	shared
		.command("sync")
		.option(
			"--account <selector>",
			"Existing account for bounded explicit Bird/xurl search",
		)
		.action(async (options) => {
			print(
				await syncTweetSearch({
					query: sharedInboxSearchQuery(getSharedInboxSettings()),
					account: options.account,
					mode: "auto",
					limit: 100,
					maxPages: 2,
					refresh: true,
				}),
				asJson(),
			);
		});
	shared
		.command("send <tweetId>")
		.requiredOption("--type <type>", "bug or feature")
		.option("--context <text>", "Operator context", "")
		.action(async (id: string, options) => {
			const action = sharedInboxMutationSchema.parse({
				kind: "handoff",
				id,
				classification: options.type,
				context: options.context,
			});
			if (action.kind === "handoff")
				print({ handoff: await sendSharedInboxHandoff(action) }, asJson());
		});
}
