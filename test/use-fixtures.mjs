import { registerHooks } from "node:module";

const generatedURL = new URL("../.generated/time-zones.json", import.meta.url).href;
const fixtureURL = new URL("./fixtures/time-zones.json", import.meta.url).href;

// Unit tests use fixed rules; the build validates freshly downloaded data separately.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && new URL(specifier, context.parentURL).href === generatedURL) {
      return nextResolve(fixtureURL, context);
    }
    return nextResolve(specifier, context);
  }
});
