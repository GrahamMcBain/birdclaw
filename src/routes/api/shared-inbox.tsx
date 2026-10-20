import { createFileRoute } from "@tanstack/react-router";
import { sensitiveRequestErrorResponse, jsonResponse } from "#/lib/http-effect";
import { enqueueDatabaseWrite } from "#/lib/database-writer";
import {
	getSharedInboxSettings,
	listSharedInbox,
	saveSharedInboxSettings,
	sharedInboxFilterSchema,
	sharedInboxMutationSchema,
	sharedInboxSearchQuery,
	updateSharedInboxState,
} from "#/lib/shared-inbox";
import { sendSharedInboxHandoff } from "#/lib/shared-inbox-handoff";
import { syncTweetSearch } from "#/lib/tweet-search-live";
import { ZodError } from "zod";

function privateJson(value: unknown, status = 200) {
	return jsonResponse(value, {
		status,
		headers: { "cache-control": "no-store" },
	});
}
export function getSharedInbox(request: Request) {
	const denied = sensitiveRequestErrorResponse(request);
	if (denied) return denied;
	try {
		const query = sharedInboxFilterSchema.parse(
			Object.fromEntries(new URL(request.url).searchParams),
		);
		return privateJson(listSharedInbox(query));
	} catch (error) {
		return privateJson(
			{
				message:
					error instanceof ZodError
						? "Invalid shared inbox filters"
						: "Shared inbox could not be read",
			},
			error instanceof ZodError ? 400 : 500,
		);
	}
}
let syncInFlight: Promise<unknown> | null = null;
export async function postSharedInbox(request: Request) {
	const denied = sensitiveRequestErrorResponse(request);
	if (denied) return denied;
	let input;
	try {
		input = sharedInboxMutationSchema.parse(await request.json());
	} catch {
		return privateJson({ message: "Invalid shared inbox action" }, 400);
	}
	try {
		if (input.kind === "handoff")
			return privateJson({ handoff: await sendSharedInboxHandoff(input) });
		if (input.kind === "sync") {
			if (syncInFlight)
				return privateJson(
					{ message: "Shared mentions sync already running" },
					409,
				);
			// Reuse existing account resolution, transport credentials, rate limits and canonical tweet ingestion.
			syncInFlight = syncTweetSearch({
				query: sharedInboxSearchQuery(getSharedInboxSettings()),
				account: input.account,
				mode: "auto",
				limit: 100,
				maxPages: 2,
				refresh: true,
			});
			try {
				const result = (await syncInFlight) as Awaited<
					ReturnType<typeof syncTweetSearch>
				>;
				return result.ok
					? privateJson({
							ok: true,
							count: result.count,
							source: result.source,
						})
					: privateJson(
							{
								message:
									"Live sync failed. Check the configured Bird/xurl account and credentials; cached mentions are unchanged.",
							},
							502,
						);
			} finally {
				syncInFlight = null;
			}
		}
		await enqueueDatabaseWrite((db) => {
			if (input.kind === "settings")
				saveSharedInboxSettings(input.settings, db);
			else updateSharedInboxState(input, db);
		});
		return privateJson({ ok: true });
	} catch {
		return privateJson(
			{
				message:
					"Action could not be completed. Check local tweet availability and server connection configuration.",
			},
			500,
		);
	}
}
export const Route = createFileRoute("/api/shared-inbox")({
	server: {
		handlers: {
			GET: ({ request }) => getSharedInbox(request),
			POST: ({ request }) => postSharedInbox(request),
		},
	},
});
