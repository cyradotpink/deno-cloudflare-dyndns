import { decodeBase64 } from "https://deno.land/std@0.218.2/encoding/base64.ts";
import * as cf from "./cloudflare.js";
import * as util from "./util.js";
import * as discord from "./discord.js";

const textDecoder = new TextDecoder();
const kv = await Deno.openKv(Deno.env.get("KV_PATH"));
const config = await util.getConfig();
console.log("Hello from top level! Current config:", config);

Deno.serve(async req => {
    console.log("received request with url", req.url);
    const url = new URL(req.url);
    if (url.pathname !== "/nic/update") {
        return new Response("404", { status: 404 });
    }
    const hostnameParam = url.searchParams.get("hostname") ?? "";
    const myipParam = url.searchParams.get("myip") ?? "";

    let username;
    let password;
    try {
        const authb64 = ((req.headers.get("authorization") ?? "Basic Og==").match(
            /^Basic ([a-zA-Z0-9+/=]*)$/
        ) ?? [])[1];
        if (authb64 === undefined) throw 1;
        const authString = textDecoder.decode(decodeBase64(authb64));
        username = authString.split(":")[0];
        if (authString.substring(username.length, username.length + 1) !== ":") throw 1;
        password = authString.substring(username.length + 1);
    } catch {
        return new Response("badauth");
    }
    // Note that "".split(",") === [""] , so we get badauth when no hostnames are given
    const hostNamesToUpdate = hostnameParam.split(",");
    // All hostnames listed must be known and must be accessible for the given username and password
    if (
        !hostNamesToUpdate.every(
            name =>
                (config.names[name]?.auth.findIndex(
                    auth => auth.username === username && auth.password === password
                ) ?? -1) >= 0
        )
    ) {
        return new Response("badauth");
    }

    const ipAdresses = myipParam.split(",");
    const newIpv4 = ipAdresses.find(v => v.match(/^[0-9\.]+$/)) ?? null;
    const newIpv6 = ipAdresses.find(v => v.match(/^[0-9a-fA-F:]+$/)) ?? null;

    const returnCodes = [];
    for (const _ of hostNamesToUpdate) {
        returnCodes.push("good " + [newIpv4, newIpv6].filter(v => v !== null).join(","));
    }
    const response = returnCodes.join("\n");

    let ok = false;
    while (!ok) {
        const atomic = kv.atomic();
        for (const hostname of hostNamesToUpdate) {
            const nameConfig = config.names[hostname];
            if (newIpv4 !== null) {
                if (nameConfig.records.includes("A")) {
                    atomic.set(["toUpdate", hostname, "A"], newIpv4);
                }
                if ((nameConfig.v4alt ?? null) !== null) {
                    atomic.set(["toUpdate", nameConfig.v4alt, "A"], newIpv4);
                }
            }
            if (newIpv6 !== null) {
                if (nameConfig.records.includes("AAAA")) {
                    atomic.set(["toUpdate", hostname, "AAAA"], newIpv6);
                }
                if ((nameConfig.v6alt ?? null) !== null) {
                    atomic.set(["toUpdate", nameConfig.v6alt, "AAAA"], newIpv6);
                }
            }
        }
        atomic.enqueue({ kind: "update", nRetry: 0, skipLock: false });
        ok = (await atomic.commit()).ok;
    }

    console.log("Sending response:\n" + response);
    return new Response(response);
});

kv.listenQueue(async message => {
    console.log("queue listener entered with message", message);

    if (message.kind !== "update") return;

    const skipLock = message.skipLock;

    let toUpdateEntries = null;
    while (true) {
        const [lockedEntry, queuedEntry] = await kv.getMany([
            ["queue", "locked"],
            ["queue", "queued"]
        ]);
        const locked = lockedEntry.value ?? false;
        const atomic = kv.atomic();
        atomic.check(lockedEntry);
        // I think this check isn't really necessary but it helps me sleep at night
        atomic.check(queuedEntry);
        if (locked && !skipLock) {
            toUpdateEntries = null;
            atomic.set(["queue", "queued"], true);
        } else {
            toUpdateEntries = [];
            for await (const v of kv.list({ prefix: ["toUpdate"] })) {
                toUpdateEntries.push(v);
            }
            atomic.set(["queue", "queued"], false);
            atomic.set(["queue", "locked"], true);
        }
        if ((await atomic.commit()).ok) {
            break;
        }
    }
    if (toUpdateEntries === null) {
        console.log("leaving queue listener early because it's locked");
        return;
    }
    // TODO its a bit suboptimal that if any uncaught error happens below this point,
    // the queue listener never gets unlocked and is broken forever

    const commitPromises = [];
    const info = { success: [], unchanged: [], failure: [], notFound: [] };
    // TODO we might want to be smarter about caching than this
    const zCache = {};
    const rCache = {};
    // TODO we could make cloudflare api requests in batches, instead of sequentially
    for (const entry of toUpdateEntries) {
        const recordContent = entry.value;
        const recordName = entry.key[1];
        const recordType = entry.key[2];

        try {
            const record = await cf.findRecord(zCache, rCache, recordName, recordType);
            if (record === null) {
                info.notFound.push({ recordName, recordType, recordContent });
                commitPromises.push(kv.atomic().check(entry).delete(entry.key).commit());
                continue;
            }
            if (record.content === recordContent) {
                info.unchanged.push({ recordName, recordType, recordContent });
                commitPromises.push(kv.atomic().check(entry).delete(entry.key).commit());
                continue;
            }
            record.content = recordContent;
            await cf.updateRecord(rCache, record);
            info.success.push({ recordName, recordType, recordContent });
        } catch (err) {
            console.log("caught error", err);
            // TODO cause a retry on other conditions, like network failures or ratelimiting
            if (err?.statusCode === 500) {
                break;
            } else {
                info.failure.push({ recordName, recordType, recordContent });
            }
        }
        commitPromises.push(kv.atomic().check(entry).delete(entry.key).commit());
    }
    info.retry = toUpdateEntries
        .slice(commitPromises.length)
        .map(v => ({ recordName: v.value, recordType: v.key[2], recordContent: v.key[1] }));

    console.log("updates summary:", info);

    const infoString =
        [
            ["Updated", info.success],
            ["Unchanged, ignored", info.unchanged],
            ["Skipped (Record not found)", info.notFound],
            ["Failed", info.failure],
            ["Queued for retry", info.retry]
        ]
            .map(([title, info]) =>
                info.length === 0
                    ? null
                    : `${title}:\n${info
                          .map(v => `${v.recordName} (${v.recordType}) to ${v.recordContent}`)
                          .join("\n")}`
            )
            .filter(v => v !== null)
            .join("\n\n") || "Uhhh nothing?";

    discord.executeWebhook(infoString);

    await Promise.all(commitPromises);

    const queueRetry = commitPromises.length < toUpdateEntries.length;
    if (queueRetry) {
        kv.enqueue(
            { kind: "update", nRetry: Math.min(message.nRetry + 1, 7), skipLock: true },
            { delay: Math.ceil((1.4 ** message.nRetry - 1) * 25) * 1000 }
        );
        return;
    }

    while (true) {
        const queuedEntry = await kv.get(["queue", "queued"]);
        const queued = queuedEntry.value ?? false;
        const atomic = kv.atomic();
        atomic.check(queuedEntry);
        if (queued) {
            atomic.enqueue({ kind: "update", nRetry: 0, skipLock: true });
        } else {
            atomic.set(["queue", "locked"], false);
        }
        if ((await atomic.commit()).ok) {
            break;
        }
    }
});
