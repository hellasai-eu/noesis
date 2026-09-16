import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft,
  Building2,
  FileText,
  Loader2,
  Database,
  Cloud,
  CloudOff,
  CheckCircle,
  XCircle,
  Clock,
  RefreshCw,
  AlertTriangle,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  BookOpen,
  ExternalLink,
  FileCode,
} from "lucide-react";
import { toast } from "sonner";

interface Institution {
  id: string;
  name: string;
  slug: string;
  vector_store_id: string | null;
  vectorStoreValid?: boolean | null;
  checkingVectorStore?: boolean;
  creatingVectorStore?: boolean;
}

interface MaterialWithDetails {
  id: string;
  file_name: string;
  title: string | null;
  material_type: string;
  openai_file_id: string | null;
  file_size: number | null;
  course_id: string;
  course_title: string;
  institution_id: string;
  institution_name: string;
  vector_store_id: string | null;
  vectorStoreStatus?: {
    inVectorStore: boolean;
    status: string | null;
    lastError: any;
  } | null;
  checkingStatus?: boolean;
  syncing?: boolean;
  expanded?: boolean;
  loadingChapters?: boolean;
  chapters?: ChapterDetails[];
}

interface ChapterDetails {
  id: string;
  title: string;
  chapter_number: number;
  openai_file_id: string | null;
  file_url: string | null;
  file_name: string | null;
  content: string | null;
  content_type: string;
}

const VectorStoreAdmin = () => {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [materials, setMaterials] = useState<MaterialWithDetails[]>([]);
  const [checkingAll, setCheckingAll] = useState(false);
  const [institutionSearch, setInstitutionSearch] = useState<string>("");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 20;

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    const checkSuperAdmin = async () => {
      if (!user) return;
      const { data } = await supabase.rpc("is_super_admin", { _user_id: user.id });
      if (!data) {
        toast.error("Access denied - Super admin only");
        navigate("/dashboard");
        return;
      }
      setIsSuperAdmin(true);
      await fetchData();
    };
    if (user) checkSuperAdmin();
  }, [user, navigate]);

  const fetchData = async () => {
    setLoading(true);
    try {
      // Fetch all institutions
      const { data: institutionsData, error: instError } = await supabase
        .from("institutions")
        .select("id, name, slug, vector_store_id")
        .order("name");

      if (instError) throw instError;
      setInstitutions(institutionsData || []);

      // Fetch all materials with course and institution info
      const { data: materialsData, error: matError } = await supabase
        .from("course_materials")
        .select(`
          id,
          file_name,
          title,
          material_type,
          openai_file_id,
          file_size,
          course_id,
          courses!inner (
            id,
            title,
            institution_id,
            institutions!inner (
              id,
              name,
              vector_store_id
            )
          )
        `)
        .neq("material_type", "images")
        .order("created_at", { ascending: false });

      if (matError) throw matError;

      const formattedMaterials: MaterialWithDetails[] = (materialsData || []).map((m: any) => ({
        id: m.id,
        file_name: m.file_name,
        title: m.title,
        material_type: m.material_type,
        openai_file_id: m.openai_file_id,
        file_size: m.file_size,
        course_id: m.course_id,
        course_title: m.courses?.title || "Unknown",
        institution_id: m.courses?.institution_id || "",
        institution_name: m.courses?.institutions?.name || "Unknown",
        vector_store_id: m.courses?.institutions?.vector_store_id || null,
      }));

      setMaterials(formattedMaterials);
    } catch (error: any) {
      console.error("Error fetching data:", error);
      toast.error("Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateVectorStore = async (institution: Institution) => {
    setInstitutions(prev => prev.map(i => 
      i.id === institution.id ? { ...i, creatingVectorStore: true } : i
    ));

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-vector-store`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'create',
            institutionId: institution.id,
            institutionName: institution.name,
          }),
        }
      );

      const data = await response.json();

      if (response.ok && data.vectorStoreId) {
        toast.success("Vector store created successfully");
        setInstitutions(prev => prev.map(i => 
          i.id === institution.id ? { ...i, vector_store_id: data.vectorStoreId, creatingVectorStore: false } : i
        ));
      } else {
        throw new Error(data.error || "Failed to create vector store");
      }
    } catch (error) {
      console.error("Error creating vector store:", error);
      toast.error("Failed to create vector store");
      setInstitutions(prev => prev.map(i => 
        i.id === institution.id ? { ...i, creatingVectorStore: false } : i
      ));
    }
  };

  const checkVectorStoreValid = async (institution: Institution) => {
    if (!institution.vector_store_id) return;

    setInstitutions(prev => prev.map(i => 
      i.id === institution.id ? { ...i, checkingVectorStore: true } : i
    ));

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      // Use the manage-vector-store function to verify
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-vector-store`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'sync',
            institutionId: institution.id,
          }),
        }
      );

      const data = await response.json();
      console.log("Vector store check response:", data);
      const isValid = response.ok && !!data.vectorStoreId;

      setInstitutions(prev => prev.map(i => 
        i.id === institution.id ? { ...i, vectorStoreValid: isValid, checkingVectorStore: false } : i
      ));
      
      toast.success(isValid ? "Vector store is valid" : "Vector store is invalid");
    } catch (error) {
      console.error("Error checking vector store:", error);
      setInstitutions(prev => prev.map(i => 
        i.id === institution.id ? { ...i, vectorStoreValid: false, checkingVectorStore: false } : i
      ));
    }
  };

  const checkMaterialVectorStatus = async (material: MaterialWithDetails) => {
    if (!material.openai_file_id || !material.vector_store_id) return;

    setMaterials(prev => prev.map(m => 
      m.id === material.id ? { ...m, checkingStatus: true } : m
    ));

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/check-vector-store-file`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            openaiFileId: material.openai_file_id,
            vectorStoreId: material.vector_store_id,
          }),
        }
      );

      if (!response.ok) {
        throw new Error('Failed to check status');
      }

      const data = await response.json();

      setMaterials(prev => prev.map(m => 
        m.id === material.id ? {
          ...m,
          vectorStoreStatus: {
            inVectorStore: data.inVectorStore,
            status: data.status,
            lastError: data.lastError,
          },
          checkingStatus: false,
        } : m
      ));
    } catch (error) {
      console.error("Error checking material status:", error);
      setMaterials(prev => prev.map(m => 
        m.id === material.id ? { ...m, checkingStatus: false } : m
      ));
    }
  };

  const checkAllMaterialsStatus = async () => {
    setCheckingAll(true);
    const materialsToCheck = materials.filter(m => m.openai_file_id && m.vector_store_id);
    
    for (const material of materialsToCheck) {
      await checkMaterialVectorStatus(material);
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    setCheckingAll(false);
    toast.success(`Checked ${materialsToCheck.length} materials`);
  };

  const syncMaterialToVectorStore = async (material: MaterialWithDetails) => {
    if (!material.openai_file_id || !material.vector_store_id) {
      toast.error("Material must be uploaded to OpenAI and have a vector store");
      return;
    }

    setMaterials(prev => prev.map(m => 
      m.id === material.id ? { ...m, syncing: true } : m
    ));

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      // Add file to vector store
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/upload-to-openai`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'add-to-vector-store',
            openaiFileId: material.openai_file_id,
            vectorStoreId: material.vector_store_id,
            materialId: material.id,
          }),
        }
      );

      const data = await response.json();

      if (response.ok && data.success) {
        toast.success("Material synced to vector store");
        // Refresh the status
        await checkMaterialVectorStatus(material);
      } else {
        throw new Error(data.error || "Failed to sync");
      }
    } catch (error) {
      console.error("Error syncing material:", error);
      toast.error("Failed to sync material to vector store");
    } finally {
      setMaterials(prev => prev.map(m => 
        m.id === material.id ? { ...m, syncing: false } : m
      ));
    }
  };

  const toggleMaterialExpansion = async (material: MaterialWithDetails) => {
    // If already expanded, collapse
    if (material.expanded) {
      setMaterials(prev => prev.map(m =>
        m.id === material.id ? { ...m, expanded: false } : m
      ));
      return;
    }

    // If already have chapters, just expand
    if (material.chapters) {
      setMaterials(prev => prev.map(m =>
        m.id === material.id ? { ...m, expanded: true } : m
      ));
      return;
    }

    // Fetch chapters
    setMaterials(prev => prev.map(m =>
      m.id === material.id ? { ...m, expanded: true, loadingChapters: true } : m
    ));

    try {
      const { data: chapters, error } = await supabase
        .from("material_chapters")
        .select("id, title, chapter_number, openai_file_id, file_url, file_name, content, content_type")
        .eq("material_id", material.id)
        .order("chapter_number").order("id");

      if (error) throw error;

      setMaterials(prev => prev.map(m =>
        m.id === material.id ? { ...m, loadingChapters: false, chapters: chapters || [] } : m
      ));
    } catch (error) {
      console.error("Error fetching chapters:", error);
      setMaterials(prev => prev.map(m =>
        m.id === material.id ? { ...m, loadingChapters: false, chapters: [] } : m
      ));
    }
  };

  const renderOpenAIStatus = (material: MaterialWithDetails) => {
    if (material.openai_file_id) {
      return (
        <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/20 gap-1">
          <Cloud className="w-3 h-3" />
          Uploaded
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="bg-muted text-muted-foreground gap-1">
        <CloudOff className="w-3 h-3" />
        Not Uploaded
      </Badge>
    );
  };

  const renderVectorStoreStatus = (material: MaterialWithDetails) => {
    if (!material.vector_store_id) {
      return (
        <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/20 gap-1">
          <AlertTriangle className="w-3 h-3" />
          No Vector Store
        </Badge>
      );
    }

    if (!material.openai_file_id) {
      return (
        <Badge variant="outline" className="text-muted-foreground gap-1">
          —
        </Badge>
      );
    }

    if (material.checkingStatus) {
      return (
        <Badge variant="outline" className="gap-1">
          <Loader2 className="w-3 h-3 animate-spin" />
          Checking...
        </Badge>
      );
    }

    if (!material.vectorStoreStatus) {
      return (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => checkMaterialVectorStatus(material)}
          className="h-6 text-xs"
        >
          <RefreshCw className="w-3 h-3 mr-1" />
          Check
        </Button>
      );
    }

    const status = material.vectorStoreStatus;

    const renderStatusBadge = () => {
      if (!status.inVectorStore) {
        return (
          <Badge variant="outline" className="bg-red-500/10 text-red-600 border-red-500/20 gap-1">
            <XCircle className="w-3 h-3" />
            Not in VS
          </Badge>
        );
      }

      switch (status.status) {
        case 'completed':
          return (
            <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/20 gap-1">
              <CheckCircle className="w-3 h-3" />
              Indexed
            </Badge>
          );
        case 'in_progress':
          return (
            <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/20 gap-1">
              <Clock className="w-3 h-3" />
              Processing
            </Badge>
          );
        case 'failed':
          return (
            <Badge variant="outline" className="bg-red-500/10 text-red-600 border-red-500/20 gap-1" title={status.lastError?.message}>
              <XCircle className="w-3 h-3" />
              Failed
            </Badge>
          );
        default:
          return (
            <Badge variant="outline" className="gap-1">
              {status.status || 'Unknown'}
            </Badge>
          );
      }
    };

    return (
      <div className="flex items-center gap-2">
        {renderStatusBadge()}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => checkMaterialVectorStatus(material)}
          className="h-6 w-6 p-0"
          title="Re-check status"
        >
          <RefreshCw className="w-3 h-3" />
        </Button>
      </div>
    );
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isSuperAdmin) {
    return null;
  }

  const materialsWithOpenAI = materials.filter(m => m.openai_file_id);
  const materialsInVectorStore = materials.filter(m => 
    m.vectorStoreStatus?.inVectorStore && m.vectorStoreStatus?.status === 'completed'
  );
  const institutionsWithVS = institutions.filter(i => i.vector_store_id);

  return (
    <div className="min-h-screen bg-background">
      <nav className="border-b border-border bg-card sticky top-0 z-50">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate("/super-admin")}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
                <Database className="w-6 h-6 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-xl font-display font-bold text-foreground">Vector Store Admin</h1>
                <p className="text-sm text-muted-foreground">Manage OpenAI vector stores</p>
              </div>
            </div>
          </div>
        </div>
      </nav>

      <main className="container mx-auto px-6 py-8">
        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Total Institutions</CardDescription>
              <CardTitle className="text-3xl">{institutions.length}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {institutionsWithVS.length} with vector store
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Total Materials</CardDescription>
              <CardTitle className="text-3xl">{materials.length}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Excluding images
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Uploaded to OpenAI</CardDescription>
              <CardTitle className="text-3xl">{materialsWithOpenAI.length}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {((materialsWithOpenAI.length / materials.length) * 100 || 0).toFixed(0)}% of materials
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Indexed in Vector Store</CardDescription>
              <CardTitle className="text-3xl">{materialsInVectorStore.length}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Click "Check All" to verify
              </p>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="institutions" className="space-y-4">
          <TabsList>
            <TabsTrigger value="institutions" className="gap-2">
              <Building2 className="w-4 h-4" />
              Institutions ({institutions.length})
            </TabsTrigger>
            <TabsTrigger value="materials" className="gap-2">
              <FileText className="w-4 h-4" />
              Materials ({materials.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="institutions">
            <Card>
              <CardHeader>
                <CardTitle>All Institutions</CardTitle>
                <CardDescription>
                  Institutions and their vector store configuration
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Slug</TableHead>
                      <TableHead>Vector Store ID</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {institutions.map((institution) => (
                      <TableRow key={institution.id}>
                        <TableCell className="font-medium">{institution.name}</TableCell>
                        <TableCell className="text-muted-foreground">{institution.slug}</TableCell>
                        <TableCell>
                          {institution.vector_store_id ? (
                            <code className="text-xs bg-muted px-2 py-1 rounded">
                              {institution.vector_store_id.substring(0, 20)}...
                            </code>
                          ) : (
                            <Badge variant="outline" className="text-amber-600">None</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {institution.checkingVectorStore ? (
                            <Badge variant="outline" className="gap-1">
                              <Loader2 className="w-3 h-3 animate-spin" />
                              Checking...
                            </Badge>
                          ) : institution.vectorStoreValid === true ? (
                            <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/20 gap-1">
                              <CheckCircle className="w-3 h-3" />
                              Valid
                            </Badge>
                          ) : institution.vectorStoreValid === false ? (
                            <Badge variant="outline" className="bg-red-500/10 text-red-600 border-red-500/20 gap-1">
                              <XCircle className="w-3 h-3" />
                              Invalid
                            </Badge>
                          ) : institution.vector_store_id ? (
                            <Badge variant="outline" className="text-muted-foreground">Not Checked</Badge>
                          ) : (
                            <Badge variant="outline" className="text-muted-foreground">—</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {!institution.vector_store_id && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleCreateVectorStore(institution)}
                                disabled={institution.creatingVectorStore}
                              >
                                {institution.creatingVectorStore ? (
                                  <Loader2 className="w-4 h-4 animate-spin mr-1" />
                                ) : (
                                  <Cloud className="w-4 h-4 mr-1" />
                                )}
                                Create
                              </Button>
                            )}
                            {institution.vector_store_id && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => checkVectorStoreValid(institution)}
                                disabled={institution.checkingVectorStore}
                              >
                                <RefreshCw className="w-4 h-4 mr-1" />
                                Verify
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="materials">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>All Materials</CardTitle>
                  <CardDescription>
                    Course materials and their OpenAI/Vector Store status
                  </CardDescription>
                </div>
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      placeholder="Search institution..."
                      value={institutionSearch}
                      onChange={(e) => {
                        setInstitutionSearch(e.target.value);
                        setCurrentPage(1);
                      }}
                      className="pl-9 w-[220px]"
                    />
                  </div>
                  <Button
                    onClick={checkAllMaterialsStatus}
                    disabled={checkingAll}
                  >
                    {checkingAll ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Checking...
                      </>
                    ) : (
                      <>
                        <RefreshCw className="w-4 h-4 mr-2" />
                        Check All
                      </>
                    )}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {(() => {
                  const filteredMaterials = materials.filter(m => 
                    institutionSearch === "" || 
                    m.institution_name.toLowerCase().includes(institutionSearch.toLowerCase())
                  );
                  const totalPages = Math.ceil(filteredMaterials.length / itemsPerPage);
                  const paginatedMaterials = filteredMaterials.slice(
                    (currentPage - 1) * itemsPerPage,
                    currentPage * itemsPerPage
                  );

                  return (
                    <>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Material</TableHead>
                            <TableHead>Course</TableHead>
                            <TableHead>Institution</TableHead>
                            <TableHead>Type</TableHead>
                            <TableHead>OpenAI</TableHead>
                            <TableHead>Vector Store</TableHead>
                            <TableHead>Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {paginatedMaterials.map((material) => (
                            <>
                              <TableRow key={material.id} className="cursor-pointer hover:bg-muted/50" onClick={() => toggleMaterialExpansion(material)}>
                                <TableCell className="font-medium max-w-[250px]">
                                  <div className="flex items-center gap-2">
                                    {material.expanded ? (
                                      <ChevronUp className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                                    ) : (
                                      <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                                    )}
                                    <span className="truncate">{material.title || material.file_name}</span>
                                    {material.file_size && (
                                      <span className="text-xs text-muted-foreground flex-shrink-0">
                                        ({(material.file_size / (1024 * 1024)).toFixed(1)} MB)
                                      </span>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell className="max-w-[150px] truncate text-muted-foreground">
                                  {material.course_title}
                                </TableCell>
                                <TableCell className="max-w-[120px] truncate text-muted-foreground">
                                  {material.institution_name}
                                </TableCell>
                                <TableCell>
                                  <Badge variant="secondary" className="text-xs">
                                    {material.material_type}
                                  </Badge>
                                </TableCell>
                                <TableCell onClick={(e) => e.stopPropagation()}>{renderOpenAIStatus(material)}</TableCell>
                                <TableCell onClick={(e) => e.stopPropagation()}>{renderVectorStoreStatus(material)}</TableCell>
                                <TableCell onClick={(e) => e.stopPropagation()}>
                                  {material.openai_file_id && material.vector_store_id && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => syncMaterialToVectorStore(material)}
                                      disabled={material.syncing}
                                      className="h-7 text-xs"
                                    >
                                      {material.syncing ? (
                                        <Loader2 className="w-3 h-3 animate-spin mr-1" />
                                      ) : (
                                        <RefreshCw className="w-3 h-3 mr-1" />
                                      )}
                                      Sync
                                    </Button>
                                  )}
                                </TableCell>
                              </TableRow>
                              {/* Expanded chapters */}
                              {material.expanded && (
                                <TableRow key={`${material.id}-chapters`} className="bg-muted/30">
                                  <TableCell colSpan={7} className="p-0">
                                    <div className="py-3 px-6">
                                      {material.loadingChapters ? (
                                        <div className="flex items-center gap-2 text-muted-foreground py-2">
                                          <Loader2 className="w-4 h-4 animate-spin" />
                                          Loading chapters...
                                        </div>
                                      ) : !material.chapters || material.chapters.length === 0 ? (
                                        <p className="text-sm text-muted-foreground py-2">No chapters found for this material.</p>
                                      ) : (
                                        <div className="space-y-2">
                                          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-2">
                                            <BookOpen className="w-3.5 h-3.5" />
                                            Chapters ({material.chapters.length})
                                          </p>
                                          <div className="grid gap-2">
                                            {material.chapters.map((chapter) => (
                                              <div key={chapter.id} className="flex items-center justify-between bg-background rounded-md px-3 py-2 border">
                                                <div className="flex items-center gap-3 min-w-0">
                                                  <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded flex-shrink-0">
                                                    Ch {chapter.chapter_number}
                                                  </span>
                                                  <span className="text-sm truncate">{chapter.title}</span>
                                                  <Badge variant="outline" className="text-xs flex-shrink-0">
                                                    {chapter.content_type}
                                                  </Badge>
                                                </div>
                                                <div className="flex items-center gap-3 flex-shrink-0">
                                                  {/* OpenAI File ID */}
                                                  {chapter.openai_file_id ? (
                                                    <a
                                                      href={`https://platform.openai.com/storage/files/${chapter.openai_file_id}`}
                                                      target="_blank"
                                                      rel="noopener noreferrer"
                                                      className="flex items-center gap-1 text-xs text-primary hover:underline"
                                                      onClick={(e) => e.stopPropagation()}
                                                    >
                                                      <Cloud className="w-3 h-3" />
                                                      <code className="bg-muted px-1 rounded">{chapter.openai_file_id.substring(0, 12)}...</code>
                                                      <ExternalLink className="w-3 h-3" />
                                                    </a>
                                                  ) : (
                                                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                                                      <CloudOff className="w-3 h-3" />
                                                      No file ID
                                                    </span>
                                                  )}
                                                  
                                                  {/* Content size badge */}
                                                  {chapter.content && (
                                                    <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/20 gap-1 text-xs">
                                                      <FileCode className="w-3 h-3" />
                                                      {(chapter.content.length / 1024).toFixed(1)} KB
                                                    </Badge>
                                                  )}
                                                  {/* File-based chapter indicator */}
                                                  {chapter.file_url && !chapter.content && (
                                                    <Badge variant="outline" className="bg-blue-500/10 text-blue-600 border-blue-500/20 gap-1 text-xs">
                                                      <FileText className="w-3 h-3" />
                                                      File
                                                    </Badge>
                                                  )}
                                                </div>
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </TableCell>
                                </TableRow>
                              )}
                            </>
                          ))}
                        </TableBody>
                      </Table>

                      {/* Pagination */}
                      {totalPages > 1 && (
                        <div className="flex items-center justify-between mt-4 pt-4 border-t">
                          <p className="text-sm text-muted-foreground">
                            Showing {(currentPage - 1) * itemsPerPage + 1} - {Math.min(currentPage * itemsPerPage, filteredMaterials.length)} of {filteredMaterials.length} materials
                          </p>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                              disabled={currentPage === 1}
                            >
                              <ChevronLeft className="w-4 h-4" />
                            </Button>
                            <span className="text-sm font-medium px-2">
                              Page {currentPage} of {totalPages}
                            </span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                              disabled={currentPage === totalPages}
                            >
                              <ChevronRight className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default VectorStoreAdmin;
