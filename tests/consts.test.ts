import { assertEquals } from "../deps.ts";
import { FLUENTCI_API_URL, FLUENTCI_WS_URL } from "../src/consts.ts";

Deno.test("FLUENTCI_API_URL", () => {
  assertEquals(FLUENTCI_API_URL, "https://vm.fluentci.io");
});

Deno.test("FLUENTCI_WS_URL", () => {
  assertEquals(FLUENTCI_WS_URL, "wss://events.fluentci.io");
});
