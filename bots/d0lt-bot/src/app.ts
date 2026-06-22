// Application entrypoint. Flue generates a default app when this file is absent;
// we author it for one reason: register the observability observer at startup so
// every dispatched turn's activity (operations, tool calls, subagent tasks,
// failures) is logged. Routing is otherwise unchanged — `flue()` is mounted at
// the root exactly as the default app does, so agents, channels, and run routes
// behave identically.
//
// `observe(...)` must be registered at module-eval time (the generated entry
// hoists this file's top-level code above its body), so it is active before any
// request or alarm delivers work.

import { observe } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";
import { createConsoleObserver } from "./lib/observe.ts";

observe(createConsoleObserver());

const app = new Hono();
app.route("/", flue());

export default app;
