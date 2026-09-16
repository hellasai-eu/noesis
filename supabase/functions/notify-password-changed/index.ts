import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { withLogging } from "../_shared/logger.ts";
import { handler } from "./handler.ts";

serve(withLogging("notify-password-changed", handler));
