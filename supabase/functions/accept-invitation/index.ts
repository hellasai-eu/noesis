import { withLogging } from "../_shared/logger.ts";
import { handler } from "./handler.ts";

Deno.serve(withLogging("accept-invitation", handler));
