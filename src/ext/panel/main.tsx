import { render } from "preact";
import { PanelRoot } from "./App";
import { createBridge } from "./bridge";

const tabId = Number(new URLSearchParams(location.search).get("tabId"));

render(<PanelRoot tabId={Number.isInteger(tabId) && tabId > 0 ? tabId : null} createBridge={createBridge} />, document.getElementById("root")!);
