import { Effect } from "effect";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { getReadDb, getNativeDb } from "./db";
import type { Database } from "./sqlite";
import { enqueueDatabaseWrite } from "./database-writer";
import { runEffectPromise } from "./effect-runtime";
import { lookupPinnedOAuth2UserEffect } from "./xurl";
import {
	assertLiveAccountMatches,
	resolveLiveSyncAccount,
} from "./live-sync-engine";
import { getSharedInboxSettings, sharedInboxSearchQuery } from "./shared-inbox";
import {
	syncTweetSearchEffect,
	type SyncTweetSearchResult,
} from "./tweet-search-live";
import { writeSyncCache as persistSyncCache } from "./sync-cache";
function writeSyncCache(db: Database, key: string, value: unknown) {
	return persistSyncCache(key, value, db);
}
import { assertTeamTriageAuthHome, isTeamTriage } from "./team-triage";

const KEY = "shared-inbox:source-coverage:v1";
const TEAM_COOLDOWN_MS = 5 * 60_000;
export interface SharedInboxCoverage {
	status:
		| "never"
		| "running"
		| "succeeded"
		| "failed"
		| "interrupted"
		| "cached";
	lastAttemptAt: string | null;
	lastSuccessAt: string | null;
	source: string | null;
	fetched: number | null;
	searchedSince: string | null;
	detail: string;
}
const empty: SharedInboxCoverage = {
	status: "never",
	lastAttemptAt: null,
	lastSuccessAt: null,
	source: null,
	fetched: null,
	searchedSince: null,
	detail:
		"No live sync has been verified. An empty inbox is not proof of no mentions.",
};
export function readSharedInboxCoverage(
	db: Database = getReadDb(),
): SharedInboxCoverage {
	const row = db
		.prepare("select value_json from sync_cache where cache_key=?")
		.get(KEY) as { value_json: string } | undefined;
	if (!row) return { ...empty };
	try {
		const value = JSON.parse(row.value_json) as SharedInboxCoverage;
		if (
			![
				"never",
				"running",
				"succeeded",
				"failed",
				"interrupted",
				"cached",
			].includes(value.status)
		)
			return { ...empty };
		return value;
	} catch {
		return { ...empty };
	}
}
export function teamSourceReadiness(db: Database = getReadDb()) {
	if (!isTeamTriage())
		return {
			configured: true,
			executableAvailable: true,
			detail:
				"Uses the selected local Bird/xurl account; only an explicit sync verifies a live source.",
		};
	const selector = process.env.BIRDCLAW_TRIAGE_SYNC_ACCOUNT?.trim();
	let executableAvailable = false;
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		try {
			accessSync(path.join(directory, "xurl"), constants.X_OK);
			executableAvailable = true;
			break;
		} catch {
			/* no executable here */
		}
	}
	let accountReady = false;
	if (selector) {
		try {
			assertTeamTriageAuthHome();
			const account = resolveLiveSyncAccount(db, selector);
			accountReady = Boolean(
				/^[A-Za-z0-9_.-]{1,100}$/.test(
					process.env.BIRDCLAW_XURL_OAUTH2_APP ?? "",
				) &&
				account.externalUserId &&
				process.env.BIRDCLAW_XURL_OAUTH2_USERNAME?.trim() === account.username,
			);
		} catch {
			/* not provisioned */
		}
	}
	return {
		configured: accountReady && executableAvailable,
		executableAvailable,
		detail:
			accountReady && executableAvailable
				? "Dedicated xurl binding configured, not proof of authentication. See last verified live sync."
				: "Live source is not ready: provision a dedicated X account binding and xurl in the service's isolated authentication HOME. No personal archive or shared credentials are reused.",
	};
}
export class SharedInboxSyncBusyError extends Error {
	constructor(public readonly retryAfterSeconds: number) {
		super("Shared mentions sync is already running or cooling down");
	}
}
let inFlight = false;
export async function syncSharedInbox(
	account?: string,
): Promise<SyncTweetSearchResult> {
	const db = getNativeDb();
	if (inFlight) throw new SharedInboxSyncBusyError(1);
	inFlight = true;
	const team = isTeamTriage();
	const startedAt = new Date().toISOString();
	const since = team
		? new Date(Date.now() - 6 * 24 * 60 * 60_000).toISOString()
		: undefined;
	try {
		await enqueueDatabaseWrite((writer) => {
			const previous = readSharedInboxCoverage(writer);
			const retry = previous.lastAttemptAt
				? TEAM_COOLDOWN_MS - (Date.now() - Date.parse(previous.lastAttemptAt))
				: 0;
			if (team && retry > 0)
				throw new SharedInboxSyncBusyError(Math.ceil(retry / 1000));
			writeSyncCache(writer, KEY, {
				...previous,
				status: "running",
				lastAttemptAt: startedAt,
				searchedSince: since ?? null,
				detail:
					"A bounded source read is running; cached triage remains available.",
			});
		}, db);
		try {
			const binding = team
				? {
						app: process.env.BIRDCLAW_XURL_OAUTH2_APP?.trim() ?? "",
						username: process.env.BIRDCLAW_XURL_OAUTH2_USERNAME?.trim() ?? "",
					}
				: undefined;
			const job = Effect.gen(function* () {
				if (team) {
					assertTeamTriageAuthHome();
					if (
						account !== undefined ||
						!teamSourceReadiness(db).configured ||
						!binding
					)
						throw new Error("Dedicated source is not ready");
					const selected = resolveLiveSyncAccount(
						db,
						process.env.BIRDCLAW_TRIAGE_SYNC_ACCOUNT,
					);
					const live = yield* lookupPinnedOAuth2UserEffect(binding, {
						timeoutMs: 20_000,
					}).pipe(
						Effect.timeoutFail({
							duration: 20_000,
							onTimeout: () =>
								new Error("Dedicated X identity verification timed out"),
						}),
					);
					if (
						!live ||
						typeof live.username !== "string" ||
						typeof live.id !== "string"
					)
						throw new Error("X identity verification failed");
					assertLiveAccountMatches({
						source: "xurl",
						account: selected,
						liveUsername: live.username,
						liveExternalUserId: live.id,
					});
				}
				return yield* syncTweetSearchEffect({
					query: sharedInboxSearchQuery(getSharedInboxSettings(db)),
					account: team ? process.env.BIRDCLAW_TRIAGE_SYNC_ACCOUNT : account,
					mode: team ? "xurl" : "auto",
					limit: 100,
					maxPages: 2,
					refresh: true,
					...(since ? { since } : {}),
					...(binding ? { pinnedOAuth2: binding } : {}),
					timeoutMs: team ? 20_000 : undefined,
				});
			});
			const result = await runEffectPromise(
				team
					? job.pipe(
							Effect.timeoutFail({
								duration: 60_000,
								onTimeout: () =>
									new Error("Bounded shared mentions sync timed out"),
							}),
						)
					: job,
			);
			await enqueueDatabaseWrite((writer) => {
				const previous = readSharedInboxCoverage(writer);
				const live = result.ok && result.source !== "cache";
				writeSyncCache(writer, KEY, {
					...previous,
					status: result.ok ? (live ? "succeeded" : "cached") : "failed",
					lastSuccessAt: live
						? new Date().toISOString()
						: previous.lastSuccessAt,
					source: result.source,
					fetched: result.ok ? result.count : null,
					detail: result.ok
						? live
							? "Last bounded source read succeeded. At most 100 results / two pages; this is not complete historical or continuous coverage."
							: "Only cached data was read; a live connection was not verified."
						: "Last source read failed. Connection/permissions require operator attention; cached rows do not establish current coverage.",
				});
			}, db);
			return result;
		} catch {
			await enqueueDatabaseWrite(
				(writer) =>
					writeSyncCache(writer, KEY, {
						...readSharedInboxCoverage(writer),
						status: "failed",
						detail:
							"Live source verification or sync failed. Check the dedicated service account and permissions; no credential diagnostics are exposed.",
					}),
				db,
			);
			throw new Error("Live source verification or sync failed");
		}
	} finally {
		inFlight = false;
	}
}
export function recoverSharedInboxCoverage(db: Database = getNativeDb()) {
	const previous = readSharedInboxCoverage(db);
	if (previous.status === "running")
		writeSyncCache(db, KEY, {
			...previous,
			status: "interrupted",
			detail:
				"The service restarted during a source read. Its outcome is incomplete; cached rows are not current coverage.",
		});
}
