// 用真实 pi 0.84.1 ModelRuntime 复现:注册 alibaba.ts config → getModel 查找
import { ModelRuntime } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js";

// 1. 从 alibaba.ts 捕获真实 config
const mod = await import("/Users/lsmir2/.pi/agent/extensions/alibaba.ts");
const factory = mod.default;
let captured;
const stubPi = {
  registerProvider(name, config) {
    if (name === "alibaba-coding") captured = config;
  },
  registerCommand() {}, on() {}, registerNativeProvider() {}, unregisterProvider() {},
};
await factory(stubPi);
console.log("captured alibaba-coding config:", JSON.stringify({ api: captured.api, baseUrl: captured.baseUrl, authHeader: captured.authHeader, models: captured.models?.length, oauth: !!captured.oauth }));

// 2. 真实 ModelRuntime
const runtime = await ModelRuntime.create({});
console.log("runtime created, builtin providers:", runtime.getRegisteredProviderIds().length);

// 3. 注册并查找
try {
  runtime.registerProvider("alibaba-coding", captured);
  console.log("registerProvider OK");
  const model = runtime.getModel("alibaba-coding", "qwen3.7-plus");
  console.log("getModel:", model ? `FOUND ${model.id} (${model.provider})` : "NOT FOUND");
  const all = runtime.getRegisteredProviderIds();
  console.log("registered providers:", all.join(", "));
} catch (e) {
  console.log("register/getModel THREW:", e instanceof Error ? e.stack : String(e));
}
