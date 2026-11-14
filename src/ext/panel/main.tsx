import { render } from "preact";
import { App } from "./App";
import { createBridge } from "./bridge";

const tabId = Number(new URLSearchParams(location.search).get("tabId"));
const bridge = Number.isInteger(tabId) && tabId > 0 ? createBridge(tabId) : null;

render(<App bridge={bridge} />, document.getElementById("root")!);
