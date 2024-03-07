import * as path from "https://deno.land/std@0.207.0/path/mod.ts";

let config = null;
export const getConfig = async () => {
    if (config === null) {
        let configPath = Deno.env.get("CONFIG_JS_PATH");
        if (configPath !== undefined) {
            if (!path.isAbsolute(configPath)) {
                configPath = path.join("..", configPath);
            }
            config = (await import(configPath)).default;
        } else {
            config = JSON.parse(Deno.env.get("CONFIG_JSON"));
        }
    }
    return config;
};
