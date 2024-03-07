import * as util from "./util.js";

const config = await util.getConfig();

export const executeWebhook = textContent => {
    const webhookUrl =
        "https://discord.com/api/webhooks/" +
        `${config.secrets.discordWebhook.id}/${config.secrets.discordWebhook.token}`;
    fetch(webhookUrl, {
        method: "POST",
        body: JSON.stringify({ content: textContent }),
        headers: { "content-type": "application/json" }
    }).catch(err => console.log("discord webhook fetch error", err));
};
