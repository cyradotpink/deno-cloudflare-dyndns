import cfApi from "npm:cloudflare@2.9.1";
const cf = cfApi({ token: "nxqa3Uftb42jq13Epdj7CHGdaFTpmliLIrmrkqH7" });

export const findZone = async (zCache, name) => {
    const zoneName = name.split(".").slice(-2).join(".");
    if (zCache[zoneName] !== undefined) return zCache[zoneName];
    const browseResult = await cf.zones.browse({ name: zoneName });
    if (browseResult.result[0] === undefined) return null;
    zCache[zoneName] = browseResult.result[0];
    return zCache[zoneName];
};

export const findRecord = async (zCache, rCache, name, type) => {
    if (rCache[name] === undefined) {
        rCache[name] = { previous_page: 0, total_pages: 1, records: [] };
    }
    let record = rCache[name].records.find(v => v.name === name && v.type === type) ?? null;
    while (record === null && rCache[name].previous_page < rCache[name].total_pages) {
        const zone = await findZone(zCache, name);
        const browseResult = await cf.dnsRecords.browse(zone.id, {
            name: name,
            page: rCache[name].previous_page + 1
        });
        rCache[name].records.push(...browseResult.result);
        record = browseResult.result.find(v => v.name === name && v.type === type) ?? null;
        rCache[name].previous_page = browseResult.result_info.page;
        rCache[name].total_pages = browseResult.result_info.total_pages;
    }
    return record;
};

export const updateRecord = async (rCache, record) => {
    const result = await cf.dnsRecords.edit(record.zone_id, record.id, record);
    const name = result.result.name;
    const cached = rCache[name].records.find(v => v.id === result.result.id);
    for (const [k, v] of Object.entries(result.result)) {
        cached[k] = v;
    }
    return result.result;
};
