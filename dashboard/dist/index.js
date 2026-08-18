(function () {
  "use strict";
  const registry = window.__HERMES_PLUGINS__;
  const SDK = window.__HERMES_PLUGIN_SDK__;
  if (!registry || !SDK) return;

  function HiddenBackendPlugin() {
    return null;
  }

  registry.register("opencode-usage", HiddenBackendPlugin);
})();
