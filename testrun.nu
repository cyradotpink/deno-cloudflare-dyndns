rm -rf kv
mkdir kv
CONFIG_JS_PATH="./config.js" KV_PATH="./kv/kv" deno run -A --unstable-kv --node-modules-dir src/main.js