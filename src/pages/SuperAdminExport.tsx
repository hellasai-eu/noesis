import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  LogOut,
  Loader2,
  Download,
  Database,
  FileJson,
  FileSpreadsheet,
  CheckSquare,
  Square,
  AlertCircle,
  Eye,
  ArrowLeft,
} from "lucide-react";
import { toast } from "sonner";
import JSZip from "jszip";
import { useFormatters } from "@/i18n/formatters";
import { BrandMark } from "@/components/BrandMark";

type ExportFormat = "json" | "csv";

interface TableInfo {
  name: string;
  rowCount: number;
  selected: boolean;
}

interface PreviewData {
  table: string;
  rows: Record<string, unknown>[];
  loading: boolean;
}

const SuperAdminExport = () => {
  const { compareText, formatNumber } = useFormatters();
  const navigate = useNavigate();
  const { user, loading, signOut } = useAuth();
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | null>(null);
  const [loadingData, setLoadingData] = useState(true);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("json");
  const [isExporting, setIsExporting] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      navigate("/auth");
      return;
    }

    if (user) {
      checkSuperAdmin();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- check on user/loading change
  }, [user, loading, navigate]);

  const checkSuperAdmin = async () => {
    try {
      const { data, error } = await supabase.rpc("is_super_admin", {
        _user_id: user!.id,
      });

      if (error) {
        console.error("Error checking super admin status:", error);
        setIsSuperAdmin(false);
        setLoadingData(false);
        return;
      }

      setIsSuperAdmin(data);

      if (data) {
        fetchTables();
      } else {
        setLoadingData(false);
      }
    } catch (error) {
      console.error("Error:", error);
      setIsSuperAdmin(false);
      setLoadingData(false);
    }
  };

  const fetchTables = async () => {
    try {
      const { data, error } = await supabase.functions.invoke("export-data", {
        body: { action: "list-tables" },
      });

      if (error) throw error;

      const tableList: TableInfo[] = Object.entries(data.tables || {})
        .map(([name, count]) => ({
          name,
          rowCount: count as number,
          selected: (count as number) >= 0, // Auto-select accessible tables
        }))
        .sort((a, b) => compareText(a.name, b.name));

      setTables(tableList);
    } catch (error) {
      console.error("Error fetching tables:", error);
      toast.error("Failed to fetch table list");
    } finally {
      setLoadingData(false);
    }
  };

  const toggleTable = (tableName: string) => {
    setTables(tables.map(t => 
      t.name === tableName ? { ...t, selected: !t.selected } : t
    ));
  };

  const selectAll = () => {
    setTables(tables.map(t => ({ ...t, selected: t.rowCount >= 0 })));
  };

  const deselectAll = () => {
    setTables(tables.map(t => ({ ...t, selected: false })));
  };

  const handlePreview = async (tableName: string) => {
    setPreview({ table: tableName, rows: [], loading: true });
    setPreviewOpen(true);

    try {
      const { data, error } = await supabase.functions.invoke("export-data", {
        body: { action: "preview", table: tableName, limit: 3 },
      });

      if (error) throw error;

      setPreview({
        table: tableName,
        rows: data.data || [],
        loading: false,
      });
    } catch (error) {
      console.error("Preview error:", error);
      toast.error("Failed to load preview");
      setPreview({ table: tableName, rows: [], loading: false });
    }
  };

  const formatValue = (value: unknown): string => {
    if (value === null || value === undefined) return "null";
    if (typeof value === "object") return JSON.stringify(value, null, 2);
    if (typeof value === "string" && value.length > 100) return value.slice(0, 100) + "...";
    return String(value);
  };

  const convertToCSV = (data: Record<string, unknown>[]): string => {
    if (data.length === 0) return "";
    
    const headers = Object.keys(data[0]);
    const csvRows = [headers.join(",")];
    
    for (const row of data) {
      const values = headers.map(header => {
        const val = row[header];
        if (val === null || val === undefined) return "";
        if (typeof val === "object") return `"${JSON.stringify(val).replace(/"/g, '""')}"`;
        if (typeof val === "string") return `"${val.replace(/"/g, '""')}"`;
        return String(val);
      });
      csvRows.push(values.join(","));
    }
    
    return csvRows.join("\n");
  };

  const handleExport = async () => {
    const selectedTables = tables.filter(t => t.selected).map(t => t.name);
    
    if (selectedTables.length === 0) {
      toast.error("Please select at least one table to export");
      return;
    }

    setIsExporting(true);
    toast.info(`Exporting ${selectedTables.length} tables...`);

    try {
      const { data, error } = await supabase.functions.invoke("export-data", {
        body: { action: "export", tables: selectedTables },
      });

      if (error) throw error;

      // Create ZIP file
      const zip = new JSZip();
      const exportData = data.data as Record<string, unknown[]>;
      const exportErrors = data.errors as Record<string, string> | undefined;

      // Add files to ZIP
      for (const [tableName, tableData] of Object.entries(exportData)) {
        if (Array.isArray(tableData) && tableData.length > 0) {
          if (exportFormat === "json") {
            zip.file(`${tableName}.json`, JSON.stringify(tableData, null, 2));
          } else {
            zip.file(`${tableName}.csv`, convertToCSV(tableData as Record<string, unknown>[]));
          }
        }
      }

      // Add metadata file
      const metadata = {
        exportedAt: data.exportedAt,
        exportedBy: data.exportedBy,
        format: exportFormat,
        tables: selectedTables,
        rowCounts: Object.fromEntries(
          Object.entries(exportData).map(([name, data]) => [name, (data as unknown[]).length])
        ),
        errors: exportErrors,
      };
      zip.file("_metadata.json", JSON.stringify(metadata, null, 2));

      // Generate and download ZIP
      const zipBlob = await zip.generateAsync({ type: "blob" });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `noisis-export-${timestamp}.zip`;

      // Download
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const totalRows = Object.values(exportData).reduce(
        (sum, data) => sum + (data as unknown[]).length, 
        0
      );
      toast.success(`Exported ${formatNumber(totalRows)} rows from ${Object.keys(exportData).length} tables`);

      if (exportErrors && Object.keys(exportErrors).length > 0) {
        toast.warning(`Some tables had errors: ${Object.keys(exportErrors).join(", ")}`);
      }
    } catch (error) {
      console.error("Export error:", error);
      toast.error("Failed to export data");
    } finally {
      setIsExporting(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const selectedCount = tables.filter(t => t.selected).length;
  const totalRows = tables.filter(t => t.selected && t.rowCount > 0).reduce((sum, t) => sum + t.rowCount, 0);

  if (loading || loadingData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (isSuperAdmin === false) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="max-w-md w-full mx-4">
          <CardHeader className="text-center">
            <CardTitle className="text-destructive">Access Denied</CardTitle>
            <CardDescription>
              You do not have super admin privileges.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Button onClick={() => navigate("/dashboard")}>
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <nav className="border-b border-border bg-card sticky top-0 z-50">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <BrandMark
            badge={
              <span className="ml-2 text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded">
                Super Admin
              </span>
            }
          />
          <div className="flex items-center gap-4">
            <Link to="/super-admin">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Management
              </Button>
            </Link>
            <Button variant="ghost" onClick={handleSignOut}>
              <LogOut className="w-4 h-4 mr-2" />
              Sign Out
            </Button>
          </div>
        </div>
      </nav>

      <div className="container mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-display font-bold text-foreground">
              Data Export
            </h1>
            <p className="text-muted-foreground mt-1">
              Export all database tables as JSON or CSV files
            </p>
          </div>
        </div>

        {/* Export Options */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Database className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{tables.length}</p>
                  <p className="text-sm text-muted-foreground">Total Tables</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center">
                  <CheckSquare className="w-6 h-6 text-accent-foreground" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{selectedCount}</p>
                  <p className="text-sm text-muted-foreground">Selected Tables</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-lg bg-secondary flex items-center justify-center">
                  <Download className="w-6 h-6 text-secondary-foreground" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{formatNumber(totalRows)}</p>
                  <p className="text-sm text-muted-foreground">Total Rows to Export</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Export Controls */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Download className="w-5 h-5" />
              Export Settings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <Label htmlFor="format">Format:</Label>
                <Select value={exportFormat} onValueChange={(v) => setExportFormat(v as ExportFormat)}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="json">
                      <div className="flex items-center gap-2">
                        <FileJson className="w-4 h-4" />
                        JSON
                      </div>
                    </SelectItem>
                    <SelectItem value="csv">
                      <div className="flex items-center gap-2">
                        <FileSpreadsheet className="w-4 h-4" />
                        CSV
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={selectAll}>
                  <CheckSquare className="w-4 h-4 mr-1" />
                  Select All
                </Button>
                <Button variant="outline" size="sm" onClick={deselectAll}>
                  <Square className="w-4 h-4 mr-1" />
                  Deselect All
                </Button>
              </div>

              <div className="flex-1" />

              <Button 
                variant="gold" 
                onClick={handleExport} 
                disabled={isExporting || selectedCount === 0}
              >
                {isExporting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Exporting...
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4 mr-2" />
                    Export {selectedCount} Tables as ZIP
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Tables List */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="w-5 h-5" />
              Available Tables
            </CardTitle>
            <CardDescription>
              Select which tables to include in the export
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">Select</TableHead>
                    <TableHead>Table Name</TableHead>
                    <TableHead className="text-right">Row Count</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                    <TableHead className="w-20 text-center">Preview</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tables.map((table) => (
                    <TableRow key={table.name}>
                      <TableCell>
                        <Checkbox
                          checked={table.selected}
                          onCheckedChange={() => toggleTable(table.name)}
                          disabled={table.rowCount < 0}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-sm">{table.name}</TableCell>
                      <TableCell className="text-right">
                        {table.rowCount >= 0 ? (
                          formatNumber(table.rowCount)
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {table.rowCount < 0 ? (
                          <Badge variant="destructive" className="gap-1">
                            <AlertCircle className="w-3 h-3" />
                            Error
                          </Badge>
                        ) : table.rowCount === 0 ? (
                          <Badge variant="secondary">Empty</Badge>
                        ) : (
                          <Badge variant="outline" className="bg-green-500/10 text-green-700 dark:text-green-400">
                            Ready
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handlePreview(table.name)}
                          disabled={table.rowCount <= 0}
                        >
                          <Eye className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {/* Preview Dialog */}
        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="max-w-4xl max-h-[80vh]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 font-mono">
                <Database className="w-5 h-5" />
                {preview?.table}
              </DialogTitle>
              <DialogDescription>
                Last {preview?.rows.length || 0} rows from this table
              </DialogDescription>
            </DialogHeader>
            {preview?.loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-primary" />
              </div>
            ) : preview?.rows.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No data to display
              </div>
            ) : (
              <ScrollArea className="h-[50vh]">
                <div className="space-y-4">
                  {preview?.rows.map((row, idx) => (
                    <Card key={idx}>
                      <CardHeader className="py-2 px-4">
                        <CardTitle className="text-sm text-muted-foreground">
                          Row {idx + 1}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="py-2 px-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                          {Object.entries(row).map(([key, value]) => (
                            <div key={key} className="flex gap-2">
                              <span className="font-mono text-muted-foreground min-w-[120px] shrink-0">
                                {key}:
                              </span>
                              <span className="font-mono text-xs break-all">
                                {formatValue(value)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </ScrollArea>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};

export default SuperAdminExport;
