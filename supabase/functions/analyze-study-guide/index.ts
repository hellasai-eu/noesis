import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { withLogging } from "../_shared/logger.ts";
import { handler } from "./handler.ts";

serve(withLogging("analyze-study-guide", handler));
