import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { toast } from "sonner";
import { ArrowLeft, RefreshCw, Trash2, Eye, ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { format } from "date-fns";
import { Json } from "@/integrations/supabase/types";

interface AgentInteractionLog {
  id: string;
  function_name: string;
  trace_id: string | null;
  question_id: string | null;
  course_id: string | null;
  user_id: string | null;
  user_message: string | null;
  incoming_state: Json;
  evaluator_output: Json;
  planner_output: Json;
  presenter_output: string | null;
  final_response: Json;
  language: string | null;
  is_first_message: boolean | null;
  response_time_ms: number | null;
  created_at: string;
}

interface ConversationGroup {
  question_id: string;
  course_id: string | null;
  user_id: string | null;
  logs: AgentInteractionLog[];
  firstMessageAt: string;
  lastMessageAt: string;
  messageCount: number;
  totalResponseTime: number;
  language: string | null;
}

interface SystemConfig {
  id: string;
  key: string;
  value: Json;
  description: string | null;
}

// Group logs by question_id into conversations
function groupLogsByConversation(logs: AgentInteractionLog[]): ConversationGroup[] {
  const grouped = new Map<string, AgentInteractionLog[]>();
  
  // Group logs by question_id
  logs.forEach(log => {
    const key = log.question_id || `orphan-${log.id}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(log);
  });
  
  // Convert to ConversationGroup array and sort logs within each group chronologically
  const conversations: ConversationGroup[] = [];
  
  grouped.forEach((groupLogs, questionId) => {
    // Sort logs within group by created_at ascending (oldest first)
    const sortedLogs = [...groupLogs].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    
    const firstLog = sortedLogs[0];
    const lastLog = sortedLogs[sortedLogs.length - 1];
    
    conversations.push({
      question_id: questionId,
      course_id: firstLog.course_id,
      user_id: firstLog.user_id,
      logs: sortedLogs,
      firstMessageAt: firstLog.created_at,
      lastMessageAt: lastLog.created_at,
      messageCount: sortedLogs.length,
      totalResponseTime: sortedLogs.reduce((acc, log) => acc + (log.response_time_ms || 0), 0),
      language: firstLog.language,
    });
  });
  
  // Sort conversations by most recent message (descending)
  return conversations.sort(
    (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
  );
}

export default function SuperAdminAgentLogs() {
  const navigate = useNavigate();
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [logs, setLogs] = useState<AgentInteractionLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [loggingEnabled, setLoggingEnabled] = useState(false);
  const [loggingConfigId, setLoggingConfigId] = useState<string | null>(null);
  const [togglingLogging, setTogglingLogging] = useState(false);
  const [expandedConversations, setExpandedConversations] = useState<Set<string>>(new Set());
  
  // Filters
  const [filterFunctionName, setFilterFunctionName] = useState<string>("all");
  const [filterDateFrom, setFilterDateFrom] = useState<string>("");
  const [filterDateTo, setFilterDateTo] = useState<string>("");

  // Group logs into conversations
  const conversations = useMemo(() => groupLogsByConversation(logs), [logs]);

  // Check if user is super admin
  useEffect(() => {
    const checkSuperAdmin = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        navigate("/auth");
        return;
      }

      const { data, error } = await supabase.rpc("is_super_admin", { _user_id: user.id });
      
      if (error || !data) {
        toast.error("Access denied: Super admin privileges required");
        navigate("/dashboard");
        return;
      }

      setIsSuperAdmin(true);
      setIsLoading(false);
    };

    checkSuperAdmin();
  }, [navigate]);

  // Fetch logging config
  const fetchLoggingConfig = useCallback(async () => {
    const { data, error } = await supabase
      .from("system_config")
      .select("*")
      .eq("key", "agent_verbose_logging")
      .maybeSingle();

    if (error) {
      console.error("Error fetching logging config:", error);
      return;
    }

    if (data) {
      setLoggingConfigId(data.id);
      const value = data.value as { enabled?: boolean };
      setLoggingEnabled(value?.enabled === true);
    }
  }, []);

  // Fetch logs
  const fetchLogs = useCallback(async () => {
    setLogsLoading(true);
    
    let query = supabase
      .from("agent_interaction_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);

    if (filterFunctionName && filterFunctionName !== "all") {
      query = query.eq("function_name", filterFunctionName);
    }

    if (filterDateFrom) {
      query = query.gte("created_at", filterDateFrom);
    }

    if (filterDateTo) {
      query = query.lte("created_at", filterDateTo + "T23:59:59");
    }

    const { data, error } = await query;

    if (error) {
      console.error("Error fetching logs:", error);
      toast.error("Failed to fetch logs");
    } else {
      setLogs(data || []);
    }

    setLogsLoading(false);
  }, [filterFunctionName, filterDateFrom, filterDateTo]);

  useEffect(() => {
    if (isSuperAdmin) {
      fetchLoggingConfig();
      fetchLogs();
    }
  }, [isSuperAdmin, fetchLoggingConfig, fetchLogs]);

  // Toggle logging
  const handleToggleLogging = async () => {
    setTogglingLogging(true);
    
    const newValue = { enabled: !loggingEnabled };

    const { error } = await supabase
      .from("system_config")
      .update({ 
        value: newValue,
        updated_at: new Date().toISOString()
      })
      .eq("key", "agent_verbose_logging");

    if (error) {
      console.error("Error updating logging config:", error);
      toast.error("Failed to update logging setting");
    } else {
      setLoggingEnabled(!loggingEnabled);
      toast.success(`Verbose logging ${!loggingEnabled ? "enabled" : "disabled"}`);
    }

    setTogglingLogging(false);
  };

  // Delete all logs
  const handleDeleteAllLogs = async () => {
    if (!confirm("Are you sure you want to delete all agent interaction logs? This action cannot be undone.")) {
      return;
    }

    const { error } = await supabase
      .from("agent_interaction_logs")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000"); // Delete all rows

    if (error) {
      console.error("Error deleting logs:", error);
      toast.error("Failed to delete logs");
    } else {
      toast.success("All logs deleted");
      setLogs([]);
    }
  };

  // Toggle conversation expansion
  const toggleConversation = (questionId: string) => {
    const newExpanded = new Set(expandedConversations);
    if (newExpanded.has(questionId)) {
      newExpanded.delete(questionId);
    } else {
      newExpanded.add(questionId);
    }
    setExpandedConversations(newExpanded);
  };

  // Format JSON for display
  const formatJson = (json: Json): string => {
    if (!json) return "N/A";
    try {
      return JSON.stringify(json, null, 2);
    } catch {
      return String(json);
    }
  };

  // Truncate text
  const truncate = (text: string | null, maxLength: number = 40): string => {
    if (!text) return "-";
    return text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
  };

  if (isLoading) {
    return (
      <div className="container mx-auto py-8 px-4">
        <Skeleton className="h-8 w-64 mb-4" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!isSuperAdmin) {
    return (
      <div className="container mx-auto py-8 px-4">
        <p className="text-destructive">Access denied</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 px-4 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => navigate("/super-admin")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          <h1 className="text-2xl font-bold">Agent Interaction Logs</h1>
        </div>
        <div className="flex items-center gap-4">
          <Button variant="outline" size="sm" onClick={fetchLogs}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Button variant="destructive" size="sm" onClick={handleDeleteAllLogs} disabled={logs.length === 0}>
            <Trash2 className="h-4 w-4 mr-2" />
            Delete All
          </Button>
        </div>
      </div>

      {/* Logging Toggle Card */}
      <Card>
        <CardHeader>
          <CardTitle>Verbose Logging Settings</CardTitle>
          <CardDescription>
            Enable or disable detailed logging of agent interactions (the socratic-chat and study-tutor tutoring surfaces). When enabled, all LLM inputs and outputs will be stored in the database.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center space-x-4">
            <Switch
              id="verbose-logging"
              checked={loggingEnabled}
              onCheckedChange={handleToggleLogging}
              disabled={togglingLogging}
            />
            <Label htmlFor="verbose-logging" className="flex items-center gap-2">
              Verbose Logging
              <Badge variant={loggingEnabled ? "default" : "secondary"}>
                {loggingEnabled ? "Enabled" : "Disabled"}
              </Badge>
            </Label>
          </div>
        </CardContent>
      </Card>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label htmlFor="function-filter">Function Name</Label>
              <Select value={filterFunctionName} onValueChange={setFilterFunctionName}>
                <SelectTrigger id="function-filter">
                  <SelectValue placeholder="All functions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All functions</SelectItem>
                  {/*
                    These two outlived the edge functions they were named after
                    (deleted in #1441). They filter `agent_interaction_logs` by
                    the `function_name` column, which the unified `chat` turn
                    still writes from `ChatSubject.functionName` — and which
                    every historical row already carries. Renaming them to
                    "chat" would match nothing and hide the archive.
                  */}
                  <SelectItem value="socratic-chat">socratic-chat</SelectItem>
                  <SelectItem value="study-tutor">study-tutor</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="date-from">From Date</Label>
              <Input
                id="date-from"
                type="date"
                value={filterDateFrom}
                onChange={(e) => setFilterDateFrom(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="date-to">To Date</Label>
              <Input
                id="date-to"
                type="date"
                value={filterDateTo}
                onChange={(e) => setFilterDateTo(e.target.value)}
              />
            </div>
          </div>
          <div className="mt-4">
            <Button onClick={fetchLogs} size="sm">
              Apply Filters
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Grouped Logs */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Conversations 
            <Badge variant="secondary">{conversations.length}</Badge>
            <span className="text-sm font-normal text-muted-foreground">
              ({logs.length} total messages)
            </span>
          </CardTitle>
          <CardDescription>
            Logs grouped by conversation. Click to expand and see individual messages.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {logsLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No logs found. {!loggingEnabled && "Enable verbose logging to start capturing interactions."}
            </div>
          ) : (
            <div className="space-y-2">
              {conversations.map((conversation) => (
                <Collapsible
                  key={conversation.question_id}
                  open={expandedConversations.has(conversation.question_id)}
                  onOpenChange={() => toggleConversation(conversation.question_id)}
                >
                  {/* Conversation Header */}
                  <CollapsibleTrigger asChild>
                    <div className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-muted/50 cursor-pointer transition-colors">
                      <div className="flex items-center gap-3">
                        {expandedConversations.has(conversation.question_id) ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        )}
                        <MessageSquare className="h-4 w-4 text-primary" />
                        <div className="flex flex-col">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm">
                              {conversation.question_id.startsWith('orphan-') 
                                ? 'No Question ID' 
                                : truncate(conversation.question_id, 12)}
                            </span>
                            <Badge variant="secondary" className="text-xs">
                              {conversation.messageCount} {conversation.messageCount === 1 ? 'msg' : 'msgs'}
                            </Badge>
                            {conversation.language && (
                              <Badge variant="outline" className="text-xs">
                                {conversation.language}
                              </Badge>
                            )}
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(conversation.firstMessageAt), "MMM d, HH:mm")}
                            {conversation.messageCount > 1 && (
                              <> → {format(new Date(conversation.lastMessageAt), "HH:mm")}</>
                            )}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 text-sm text-muted-foreground">
                        <span>{conversation.totalResponseTime}ms total</span>
                      </div>
                    </div>
                  </CollapsibleTrigger>

                  {/* Conversation Messages */}
                  <CollapsibleContent>
                    <div className="ml-6 mt-1 border-l-2 border-muted pl-4 space-y-1">
                      {conversation.logs.map((log, index) => (
                        <div
                          key={log.id}
                          className="flex items-start justify-between p-3 rounded-md bg-muted/30 hover:bg-muted/50 transition-colors"
                        >
                          <div className="flex items-start gap-3 flex-1 min-w-0">
                            <div className="flex flex-col items-center">
                              <span className="text-xs text-muted-foreground font-mono">
                                #{index + 1}
                              </span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-xs text-muted-foreground">
                                  {format(new Date(log.created_at), "HH:mm:ss")}
                                </span>
                                {log.is_first_message && (
                                  <Badge variant="default" className="text-xs">First</Badge>
                                )}
                                <Badge variant="outline" className="text-xs">
                                  {log.function_name}
                                </Badge>
                                {log.response_time_ms && (
                                  <span className="text-xs text-muted-foreground">
                                    {log.response_time_ms}ms
                                  </span>
                                )}
                              </div>
                              <p className="text-sm truncate">
                                <span className="font-medium">User:</span>{" "}
                                {truncate(log.user_message, 80)}
                              </p>
                              {log.presenter_output && (
                                <p className="text-sm text-muted-foreground truncate mt-1">
                                  <span className="font-medium">AI:</span>{" "}
                                  {truncate(log.presenter_output, 80)}
                                </p>
                              )}
                            </div>
                          </div>
                          <Dialog>
                            <DialogTrigger asChild>
                              <Button variant="ghost" size="sm" className="ml-2 shrink-0">
                                <Eye className="h-4 w-4" />
                              </Button>
                            </DialogTrigger>
                            <DialogContent className="max-w-4xl max-h-[90vh]">
                              <DialogHeader>
                                <DialogTitle>Interaction Details</DialogTitle>
                                <DialogDescription>
                                  Trace ID: {log.trace_id || "N/A"}
                                </DialogDescription>
                              </DialogHeader>
                              <ScrollArea className="max-h-[70vh]">
                                <div className="space-y-4">
                                  <div>
                                    <Label className="font-bold">User Message</Label>
                                    <pre className="bg-muted p-3 rounded-md text-sm overflow-x-auto whitespace-pre-wrap">
                                      {log.user_message || "N/A"}
                                    </pre>
                                  </div>
                                  <div>
                                    <Label className="font-bold">Incoming State</Label>
                                    <pre className="bg-muted p-3 rounded-md text-sm overflow-x-auto">
                                      {formatJson(log.incoming_state)}
                                    </pre>
                                  </div>
                                  <div>
                                    <Label className="font-bold">Evaluator Output</Label>
                                    <pre className="bg-muted p-3 rounded-md text-sm overflow-x-auto">
                                      {formatJson(log.evaluator_output)}
                                    </pre>
                                  </div>
                                  <div>
                                    <Label className="font-bold">Planner Output</Label>
                                    <pre className="bg-muted p-3 rounded-md text-sm overflow-x-auto">
                                      {formatJson(log.planner_output)}
                                    </pre>
                                  </div>
                                  <div>
                                    <Label className="font-bold">Presenter Output</Label>
                                    <pre className="bg-muted p-3 rounded-md text-sm overflow-x-auto whitespace-pre-wrap">
                                      {log.presenter_output || "N/A"}
                                    </pre>
                                  </div>
                                  <div>
                                    <Label className="font-bold">Final Response</Label>
                                    <pre className="bg-muted p-3 rounded-md text-sm overflow-x-auto">
                                      {formatJson(log.final_response)}
                                    </pre>
                                  </div>
                                  <div className="grid grid-cols-2 gap-4">
                                    <div>
                                      <Label className="font-bold">Question ID</Label>
                                      <p className="text-sm text-muted-foreground">{log.question_id || "N/A"}</p>
                                    </div>
                                    <div>
                                      <Label className="font-bold">Course ID</Label>
                                      <p className="text-sm text-muted-foreground">{log.course_id || "N/A"}</p>
                                    </div>
                                    <div>
                                      <Label className="font-bold">User ID</Label>
                                      <p className="text-sm text-muted-foreground">{log.user_id || "N/A"}</p>
                                    </div>
                                    <div>
                                      <Label className="font-bold">Response Time</Label>
                                      <p className="text-sm text-muted-foreground">
                                        {log.response_time_ms ? `${log.response_time_ms}ms` : "N/A"}
                                      </p>
                                    </div>
                                  </div>
                                </div>
                              </ScrollArea>
                            </DialogContent>
                          </Dialog>
                        </div>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
