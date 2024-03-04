import { decodeBase64 } from "https://deno.land/std@0.218.2/encoding/base64.ts";
import * as cf from "./cloudflare.js";

const textDecoder = new TextDecoder();

const kv = await Deno.openKv();

const bwspeedportAuth = {
    username: "speedportbw",
    password: "nfz2KOagkr4JAwyvOCr33j0K08Yv5TGP"
};

const hostnames = {
    "bw.cyra.pink": {
        records: ["A", "AAAA"],
        v4alt: "bw4.cyra.pink",
        v6alt: null,
        auth: [bwspeedportAuth]
    }
};

Deno.serve(async req => {
    console.log(req);
    const url = new URL(req.url);
    console.log(url);
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
    const hostNamesToUpdate = hostnameParam.split(",");
    console.log(hostNamesToUpdate, username, password);
    if (
        !hostNamesToUpdate.every(
            name =>
                (hostnames[name]?.auth.findIndex(
                    auth => auth.username === username && auth.password === password
                ) ?? 0) >= 0
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

    let ok = false;
    while (!ok) {
        const atomic = kv.atomic();
        for (const hostname of hostNamesToUpdate) {
            if (newIpv4 !== null) atomic.set(["toUpdate", hostname, "A"], newIpv4);
            if (newIpv6 !== null) atomic.set(["toUpdate", hostname, "AAAA"], newIpv6);
        }
        atomic.enqueue({ kind: "update", retryId: null });
        ok = (await atomic.commit()).ok;
        console.log(ok);
    }

    return new Response(returnCodes.join("\n"));
});

kv.listenQueue(async message => {
    if (message.kind !== "update") return;

    const [retryId, _retryN] = await kv.getMany([["nextRetryId"], ["nextRetryN"]]);
    console.log("Queue handler entered with retryId", retryId);

    // if nextRetryId in the db is not null it means there was previously some failure with cloudflare
    // and a retry is queued up. In this case, we skip the regular handling of incoming update requests
    // and let the queued up retry eventually deal with it.
    if (retryId.value !== message.retryId) return;

    let ok = false;
    let toUpdateEntries;
    while (!ok) {
        toUpdateEntries = [];
        const iter = kv.list({ prefix: ["toUpdate"] });
        for await (const v of iter) toUpdateEntries.push(v);
        const atomic = kv.atomic();
        atomic.check(...toUpdateEntries);
        toUpdateEntries.forEach(v => atomic.delete(v.key));
        ok = (await atomic.commit()).ok;
    }

    const toUpdate = toUpdateEntries.map(v => ({
        name: v.key[1],
        type: v.key[2],
        value: v.value,
        entry: v
    }));
    console.log("entries to update", toUpdate);

    const retryList = [];
    const zCache = {};
    const rCache = {};
    for (const [i, candidate] of toUpdate.entries()) {
        try {
            const record = await cf.findRecord(zCache, rCache, candidate.name, candidate.type);
            if (record === null) {
                console.log("skipping record because not found", candidate.name, candidate.type);
                continue;
            }
            record.content = candidate.value;
            await cf.updateRecord(rCache, record);
        } catch (err) {
            console.log("caught error", err);
            // TODO cause a retry on other conditions, like network failures?
            if (err?.statusCode === 500) {
                retryList = toUpdate.slice(i);
                break;
            } else {
                console.log("error was probably client's fault, ignoring");
            }
        }
    }
    console.log("queuing retries", retryList);

    // We know we're done if the current handler call was a regular update (not a retry) and no new retries are necessary.
    if (retryId.value === null && retryList.length <= 0) {
        return;
    }

    ok = false;
    while (!ok && retryList.length > 0) {
        const atomic = kv.atomic();
        for (const retry of retryList) {
            await atomic.set(retry.key, retry.value);
        }
        ok = (await atomic.commit()).ok;
    }

    // If we're in a retry and succeeded, we may have blocked some regular updates in the meantime,
    // and need to queue up a regular update.
    const nextRetryId = retryList.length > 0 ? Math.floor(Math.random() * 2 ** 50) : null;
    ok = false;
    while (!ok) {
        const atomic = kv.atomic();
        // If we're in a regular update, we need to check if another regular update
        // has queued up a retry already.
        if (retryId.value === null) {
            const nowRetryId = await kv.get(["nextRetryId"]);
            if (nowRetryId.value !== null) {
                break;
            }
            atomic.check(nowRetryId);
        }
        atomic.set(["nextRetryId"], nextRetryId);
        // TODO exponential backoff or sth idk
        atomic.enqueue({
            kind: "update",
            retryId: nextRetryId,
            delay: nextRetryId === null ? 0 : 60000
        });
        ok = (await atomic.commit()).ok;
    }
});
