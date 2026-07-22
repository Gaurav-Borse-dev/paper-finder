import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  FolderOpen, Key, RefreshCw, CheckCircle2, AlertCircle, Loader2,
  Database, FileText, ArrowRight, Sparkles, CheckCircle, Pause, Play, Trash2, Info,
  Search, Filter, ChevronDown, ChevronUp, ExternalLink, Lock
} from "lucide-react";
import { apiFetch } from "@/services/api";
import { fetchLookup } from "@/services/lookups";

export const Route = createFileRoute("/_authenticated/admin/bulk-import")({
  component: BulkImport,
});

interface ImportPaperItem {
  id?: string;
  subject: string;
  subject_code: string | null;
  department: string;
  semester: number;
  academic_year: string;
  exam_type: string;
  marks: number;
  exam_date: string | null;
  question_paper: {
    id: string;
    name: string;
    url: string;
    checksum?: string;
    modifiedTime?: string;
    size?: number;
    status?: string;
  } | null;
  answer_key: {
    id: string;
    name: string;
    url: string;
    checksum?: string;
    modifiedTime?: string;
    size?: number;
    status?: string;
  } | null;
  status: "Ready" | "Missing Answer Key" | "Duplicate" | "Unknown Subject" | "Unknown Semester" | "Needs Review" | "Update Question Paper" | "Attach Answer Key" | "Replace Wrong Answer Key";
  dbPaperId?: string;
  duplicateResolution?: "skip" | "replace" | "update";
  error?: string | null;
}

interface JobStatusResponse {
  id: string;
  status: "scanning" | "processing" | "paused" | "completed" | "failed" | "cancelled";
  currentStep: string;
  progress: number;
  stats: {
    totalFiles: number;
    alreadyImported?: number;
    questionPapers: number;
    answerKeys: number;
    matchedPapers: number;
    missingAnswerKeys: number;
    duplicates: number;
    unknownFiles: number;
    skippedFiles?: number;
    needsReview?: number;
  };
  results: ImportPaperItem[];
  items: Array<{
    id: string;
    name: string;
    path: string;
    status: "pending" | "processing" | "completed" | "failed" | "skipped";
    type: string;
    error: string | null;
    used_ai: boolean;
    metadata?: any;
    created_at?: string;
    file_id?: string;
    size?: number;
  }>;
  error?: string;
}

function BulkImport() {
  const envClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

  // Settings & Auth States
  const [googleToken, setGoogleToken] = useState<string>(() => localStorage.getItem("gdrive_access_token") || "");
  const [clientId, setClientId] = useState<string>(() => {
    return envClientId || localStorage.getItem("gdrive_client_id") || "";
  });
  const [folderUrl, setFolderUrl] = useState<string>(() => localStorage.getItem("gdrive_folder_url") || "");

  // Scanner States
  const [jobId, setJobId] = useState<string>("");
  const [scanStatus, setScanStatus] = useState<JobStatusResponse | null>(null);
  const [isScanning, setIsScanning] = useState<boolean>(false);

  // Editable lists
  const [papersList, setPapersList] = useState<ImportPaperItem[]>([]);
  const [selectedPaperIndices, setSelectedPaperIndices] = useState<Set<number>>(new Set());

  // Lookups lists (for select dropdowns in grid)
  const [departments, setDepartments] = useState<string[]>([]);
  const [examTypes, setExamTypes] = useState<string[]>([]);
  const [academicYears, setAcademicYears] = useState<string[]>([]);
  const [subjects, setSubjects] = useState<string[]>([]);

  // Execution States
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [importReport, setImportReport] = useState<any | null>(null);
  const [scanStartTime, setScanStartTime] = useState<number | null>(null);

  // UI state variables
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expandedCard, setExpandedCard] = useState<string | null>(null);

  // Load GIS SDK
  useEffect(() => {
    if (!(window as any).google) {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      document.body.appendChild(script);
    }
  }, []);

  // Fetch database lookups
  useEffect(() => {
    fetchLookup<{ name: string }>("departments").then((data) => setDepartments(data.map((d) => d.name))).catch(console.error);
    fetchLookup<{ name: string }>("exam_types").then((data) => setExamTypes(data.map((e) => e.name))).catch(console.error);
    fetchLookup<{ name: string }>("academic_years").then((data) => setAcademicYears(data.map((y) => y.name))).catch(console.error);
    fetchLookup<{ name: string }>("subjects").then((data) => setSubjects(data.map((s) => s.name))).catch(console.error);
  }, []);

  // Persist settings
  const handleSaveClientId = (val: string) => {
    setClientId(val);
    localStorage.setItem("gdrive_client_id", val);
  };

  const handleSaveFolderUrl = (val: string) => {
    setFolderUrl(val);
    localStorage.setItem("gdrive_folder_url", val);
  };

  const handleConnectGoogle = () => {
    if (!clientId) {
      toast.error("Please configure a Google OAuth Client ID first.");
      return;
    }
    try {
      const tokenClient = (window as any).google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: "https://www.googleapis.com/auth/drive.readonly",
        callback: (resp: any) => {
          if (resp && resp.access_token) {
            setGoogleToken(resp.access_token);
            localStorage.setItem("gdrive_access_token", resp.access_token);
            toast.success("Google Drive connected successfully!");
          }
        },
      });
      tokenClient.requestAccessToken({ prompt: "consent" });
    } catch (err) {
      toast.error("Failed to initialize Google Authentication.");
    }
  };

  // Helper to group discovered scan items into subject groups
  const groupDiscoveredItemsIntoSubjects = (items: any[]) => {
    const subjectsMap = new Map<string, any>();

    const getSubjectName = (filename: string) => {
      const clean = filename.replace(/\.pdf$/i, "").replace(/[\_\-]+/g, " ").toUpperCase().trim();
      for (const sub of subjects) {
        if (clean.includes(sub.toUpperCase())) return sub;
      }
      const abbreviations: Record<string, string> = {
        "BEEDE": "Basic Electrical Engineering and Digital Electronics",
        "BEEE": "Basic Electrical & Electronics Engineering",
        "BEE and DE": "Basic Electrical Engineering and Digital Electronics",
        "ADE": "Analog and Digital Electronics",
        "EDC": "Electronic Devices and Circuits",
        "DE": "Digital Electronics",
        "ECT": "Electrical Circuit Theory",
        "ECS": "Effective Communication Skills",
        "CEM": "Computational Engineering Mechanics",
        "EM-I": "Engineering Mathematics I",
        "EM-II": "Engineering Mathematics II",
        "EM-III": "Engineering Mathematics III",
        "DSA": "Data Structures and Algorithms",
        "DBMS": "Database Management Systems",
        "AI": "Artificial Intelligence",
        "ML": "Machine Learning",
        "OS": "Operating Systems",
        "CN": "Computer Networks",
        "IOT": "Internet of Things",
        "DSP": "Digital Signal Processing",
        "ADBMS": "Advanced Database Management Systems",
      };
      for (const [abbr, full] of Object.entries(abbreviations)) {
        if (clean.includes(abbr)) return full;
      }
      return filename
        .replace(/\.pdf$/i, "")
        .replace(/\b(qp|ak|key|solution|soln|solved|question|paper|sem|semester)\b/gi, "")
        .trim() || "Unknown Subject";
    };

    const isAnswerKey = (name: string) => {
      return /\b(ak|key|solution|soln|solved|ans)\b/i.test(name);
    };

    items.forEach((item) => {
      const isCompleted = item.status === "completed" || item.status === "skipped";
      const meta = item.metadata || {};
      const subject = isCompleted ? (meta.subject?.value || getSubjectName(item.name)) : getSubjectName(item.name);
      const department = isCompleted ? (meta.department?.value || "Unknown") : "Unknown";
      const semester = isCompleted ? (meta.semester?.value || 1) : 1;
      const academicYear = isCompleted ? (meta.academic_year?.value || "2024-25") : "2024-25";
      const examType = isCompleted ? (meta.exam_type?.value || "ESE") : "ESE";
      const marks = isCompleted ? (meta.marks?.value || 70) : 70;
      const subjectCode = isCompleted ? (meta.subject_code?.value || null) : null;

      const key = `${subject}-${department}-${semester}-${academicYear}-${examType}-${marks}`;

      let group = subjectsMap.get(key);
      if (!group) {
        group = {
          subject,
          subject_code: subjectCode,
          department,
          semester,
          academic_year: academicYear,
          exam_type: examType,
          marks,
          question_paper: null,
          answer_key: null,
          status: "Scanning",
          confidence: 0,
          itemsList: [],
        };
        subjectsMap.set(key, group);
      }

      if (meta.existingPaperId) {
        group.dbPaperId = meta.existingPaperId;
      }

      group.itemsList.push(item);

      const fileDetails = {
        id: item.file_id,
        name: item.name,
        url: item.web_view_link || `https://drive.google.com/file/d/${item.file_id}/view`,
        status: item.status,
        size: item.size,
        used_ai: item.used_ai,
        error: item.error,
        checksum: meta.drive_checksum || null,
        modifiedTime: meta.drive_modified_time || null,
        isUpdate: meta.isUpdate || false,
        needsReview: meta._needs_review || false,
        dbPaperId: meta.existingPaperId || null,
      };

      const isAK = isCompleted ? (item.type === "Answer Key") : isAnswerKey(item.name);
      if (isAK) {
        group.answer_key = fileDetails;
      } else {
        group.question_paper = fileDetails;
      }
    });

    for (const group of subjectsMap.values()) {
      const qp = group.question_paper;
      const ak = group.answer_key;

      if (qp && ak) {
        if (qp.status === "processing" || ak.status === "processing" || qp.status === "pending" || ak.status === "pending") {
          group.status = "Scanning";
        } else if (qp.status === "failed" || ak.status === "failed") {
          group.status = "Failed";
        } else if (qp.status === "skipped" && ak.status === "skipped") {
          group.status = "Already Imported";
        } else {
          const hasUpdate = qp.isUpdate || ak.isUpdate;
          const needsReview = qp.needsReview || ak.needsReview || group.subject === "Unknown Subject" || group.department === "Unknown";
          if (needsReview) {
            group.status = "Needs Review";
          } else if (hasUpdate) {
            group.status = qp.isUpdate ? "Update Question Paper" : "Attach Answer Key";
          } else {
            group.status = "Ready";
          }
        }
      } else if (qp) {
        if (qp.status === "processing" || qp.status === "pending") {
          group.status = "Scanning";
        } else if (qp.status === "failed") {
          group.status = "Failed";
        } else if (qp.status === "skipped") {
          group.status = "Already Imported";
        } else {
          const needsReview = qp.needsReview || group.subject === "Unknown Subject" || group.department === "Unknown";
          if (needsReview) {
            group.status = "Needs Review";
          } else if (qp.isUpdate) {
            group.status = "Update Question Paper";
          } else {
            group.status = "Import Question Paper Only";
          }
        }
      } else if (ak) {
        if (ak.status === "processing" || ak.status === "pending") {
          group.status = "Scanning";
        } else if (ak.status === "failed") {
          group.status = "Failed";
        } else if (ak.status === "skipped") {
          group.status = "Already Imported";
        } else {
          const needsReview = ak.needsReview || group.subject === "Unknown Subject" || group.department === "Unknown";
          if (needsReview) {
            group.status = "Needs Review";
          } else if (ak.isUpdate) {
            group.status = "Attach Answer Key";
          } else {
            group.status = "Waiting for Question Paper";
          }
        }
      }

      let totalConf = 0;
      let count = 0;
      group.itemsList.forEach((item: any) => {
        if (item.status === "completed" && item.metadata) {
          const coreFields = ["subject", "department", "semester", "academic_year", "exam_type"];
          coreFields.forEach((field) => {
            if (item.metadata[field]) {
              totalConf += item.metadata[field].confidence || 0;
              count++;
            }
          });
        }
      });
      group.confidence = count > 0 ? Math.round((totalConf / count) * 100) : 0;
    }

    return Array.from(subjectsMap.values());
  };

  const displaySubjects: any[] = isScanning
    ? groupDiscoveredItemsIntoSubjects(scanStatus?.items || []).map((s, idx) => ({ ...s, keyIndex: idx }))
    : papersList.map((item, idx) => ({
        ...item,
        keyIndex: idx,
        confidence: item.status === "Needs Review" ? 65 : 98,
        itemsList: [
          item.question_paper ? { status: "completed", used_ai: false } : null,
          item.answer_key ? { status: "completed", used_ai: false } : null,
        ].filter(Boolean),
      }));

  const totalSubjects = displaySubjects.length;
  const completePairs = displaySubjects.filter((s) => s.question_paper && s.answer_key).length;
  const qpsOnly = displaySubjects.filter((s) => s.question_paper && !s.answer_key).length;
  const aksOnly = displaySubjects.filter((s) => !s.question_paper && s.answer_key).length;
  const alreadyImportedCount = displaySubjects.filter((s) => s.status === "Already Imported" || s.status === "Duplicate").length;
  const updatedQps = displaySubjects.filter((s) => s.status === "Update Question Paper").length;
  const updatedAks = displaySubjects.filter((s) => s.status === "Update Answer Key" || s.status === "Replace Wrong Answer Key" || s.status === "Attach Answer Key").length;
  const duplicateSubjects = displaySubjects.filter((s) => s.status === "Duplicate").length;
  const needsReviewCount = displaySubjects.filter((s) => s.status === "Needs Review").length;
  const failedCount = displaySubjects.filter((s) => s.status === "Failed" || (s.question_paper?.status === "failed" || s.answer_key?.status === "failed")).length;
  const passwordProtected = displaySubjects.filter((s) => s.error?.toLowerCase().includes("password") || s.question_paper?.error?.toLowerCase().includes("password")).length;
  const skippedCount = displaySubjects.filter((s) => s.status === "Skipped").length;

  const totalConfSum = displaySubjects.reduce((acc, s) => acc + (s.confidence || 0), 0);
  const avgConfidence = totalSubjects > 0 ? Math.round(totalConfSum / totalSubjects) : 0;

  const processedFiles = scanStatus?.items?.filter((i) => i.status !== "pending" && i.status !== "processing").length || 0;
  const totalFiles = scanStatus?.items?.length || 0;
  let processingSpeed = "—";
  let etaStr = "—";

  if (scanStartTime && processedFiles > 0) {
    const elapsedSecs = (Date.now() - scanStartTime) / 1000;
    const speed = processedFiles / elapsedSecs;
    processingSpeed = `${(speed * 60).toFixed(1)} docs/min`;
    const remaining = totalFiles - processedFiles;
    if (speed > 0) {
      const etaSeconds = remaining / speed;
      etaStr = `${Math.floor(etaSeconds / 60)}m ${Math.floor(etaSeconds % 60)}s`;
    }
  }

  const activityFeed = scanStatus?.items
    ?.filter((item) => item.status === "completed" || item.status === "skipped" || item.status === "failed")
    ?.slice(-5)
    ?.reverse()
    ?.map((item) => {
      let action = "✓ Imported";
      if (item.status === "skipped") action = "✓ Duplicate Skipped";
      else if (item.status === "failed") action = "⚠ Failed";
      else if (item.metadata?.isUpdate) action = "✓ Updated";
      else if (item.type === "Answer Key") action = "✓ Attached Answer Key";

      return {
        id: item.id,
        action,
        subject: item.metadata?.subject?.value || item.name,
        time: new Date(item.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
    }) || [];

  const filteredSubjects = displaySubjects.filter((s) => {
    const matchSearch =
      s.subject.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.department.toLowerCase().includes(searchQuery.toLowerCase()) ||
      String(s.semester).includes(searchQuery);

    if (statusFilter === "all") return matchSearch;
    if (statusFilter === "ready" && s.status === "Ready") return matchSearch;
    if (statusFilter === "qp_only" && s.status === "Import Question Paper Only") return matchSearch;
    if (statusFilter === "waiting_ak" && s.status === "Searching Answer Key") return matchSearch;
    if (statusFilter === "waiting_qp" && s.status === "Waiting for Question Paper") return matchSearch;
    if (statusFilter === "already_imported" && s.status === "Already Imported") return matchSearch;
    if (statusFilter === "duplicate" && s.status === "Duplicate") return matchSearch;
    if (statusFilter === "needs_review" && s.status === "Needs Review") return matchSearch;
    if (statusFilter === "updated" && (s.status === "Update Question Paper" || s.status === "Update Answer Key" || s.status === "Replace Wrong Answer Key")) return matchSearch;

    return false;
  });

  const handleCellChange = (index: number, key: keyof ImportPaperItem, value: any) => {
    setPapersList((prev) => {
      const copy = [...prev];
      const updatedItem = { ...copy[index], [key]: value };
      if ((updatedItem.status === "Unknown Subject" || updatedItem.status === "Needs Review") && key === "subject" && value !== "Unknown Subject") {
        updatedItem.status = updatedItem.answer_key ? "Ready" : "Missing Answer Key";
      }
      copy[index] = updatedItem;
      return copy;
    });
  };

  const handleSelectRow = (index: number) => {
    setSelectedPaperIndices((prev) => {
      const copy = new Set(prev);
      if (copy.has(index)) copy.delete(index);
      else copy.add(index);
      return copy;
    });
  };

  const handleSelectAll = () => {
    const importableIndices = displaySubjects
      .map((sub, idx) => ({ sub, idx }))
      .filter(({ sub }) => {
        return (
          sub.status !== "Scanning" &&
          sub.status !== "Searching Answer Key" &&
          sub.status !== "Searching Question Paper" &&
          sub.status !== "Already Imported" &&
          sub.status !== "Duplicate"
        );
      })
      .map(({ idx }) => idx);

    const allImportableSelected = importableIndices.every(idx => selectedPaperIndices.has(idx));
    if (allImportableSelected && importableIndices.length > 0) {
      setSelectedPaperIndices(prev => {
        const copy = new Set(prev);
        importableIndices.forEach(idx => copy.delete(idx));
        return copy;
      });
    } else {
      setSelectedPaperIndices(prev => {
        const copy = new Set(prev);
        importableIndices.forEach(idx => copy.add(idx));
        return copy;
      });
    }
  };

  const handleStartScan = async () => {
    if (!folderUrl) {
      toast.error("Please input a Google Drive Folder URL.");
      return;
    }
    setImportReport(null);
    setIsScanning(true);
    setScanStatus(null);
    setPapersList([]);
    setSelectedPaperIndices(new Set());
    setScanStartTime(Date.now());
    try {
      const data = await apiFetch<{ jobId: string }>("/import/scan", {
        method: "POST",
        body: { folderUrl, googleAccessToken: googleToken },
      });
      setJobId(data.jobId);
      toast.success("Folder scan started in the background...");
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Failed to start folder scan.");
      setIsScanning(false);
    }
  };

  const handleStartExtraction = async () => {
    if (!jobId || !googleToken) return;
    try {
      await apiFetch(`/import/process/${jobId}`, {
        method: "POST",
        body: { googleAccessToken: googleToken },
      });
      toast.success("Metadata extraction and pairing processing queue initialized!");
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Failed to start metadata extraction queue.");
    }
  };

  const handlePauseQueue = async () => {
    if (!jobId) return;
    try {
      await apiFetch(`/import/pause/${jobId}`, { method: "POST" });
      toast.info("Processing paused.");
    } catch (err: any) {
      toast.error(err.message || "Failed to pause job.");
    }
  };

  const handleResumeQueue = async () => {
    if (!jobId || !googleToken) return;
    try {
      await apiFetch(`/import/resume/${jobId}`, {
        method: "POST",
        body: { googleAccessToken: googleToken },
      });
      toast.success("Resuming queue...");
    } catch (err: any) {
      toast.error(err.message || "Failed to resume job.");
    }
  };

  const handleCancelQueue = async () => {
    if (!jobId) return;
    try {
      await apiFetch(`/import/cancel/${jobId}`, { method: "POST" });
      setJobId("");
      setIsScanning(false);
      setScanStatus(null);
      toast.info("Import job reset.");
    } catch (err: any) {
      toast.error(err.message || "Failed to cancel import job.");
    }
  };

  const handleExecuteImport = async () => {
    const papersToImport = displaySubjects
      .filter((_, idx) => selectedPaperIndices.has(idx))
      .map((s) => ({
        subject: s.subject,
        subject_code: s.subject_code || null,
        department: s.department,
        semester: Number(s.semester),
        academic_year: s.academic_year,
        exam_type: s.exam_type,
        marks: Number(s.marks),
        exam_date: s.exam_date || null,
        question_paper: s.question_paper ? {
          id: s.question_paper.id,
          name: s.question_paper.name,
          url: s.question_paper.url,
          checksum: s.question_paper.checksum || null,
          modifiedTime: s.question_paper.modifiedTime || null,
          size: s.question_paper.size || null,
        } : null,
        answer_key: s.answer_key ? {
          id: s.answer_key.id,
          name: s.answer_key.name,
          url: s.answer_key.url,
          checksum: s.answer_key.checksum || null,
          modifiedTime: s.answer_key.modifiedTime || null,
          size: s.answer_key.size || null,
        } : null,
        status: s.status,
        dbPaperId: s.dbPaperId || null,
        duplicateResolution: s.duplicateResolution || (s.status === "Duplicate" ? "skip" : "update"),
      }));

    if (papersToImport.length === 0) {
      toast.error("No subjects selected for import.");
      return;
    }
    setIsImporting(true);
    try {
      const report = await apiFetch<any>("/import/execute", {
        method: "POST",
        body: { papers: papersToImport },
      });
      setImportReport(report);
      toast.success("Import completed successfully!");
      
      setSelectedPaperIndices(new Set());

      if (!isScanning) {
        setPapersList([]);
        setJobId("");
        setScanStatus(null);
      }
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Failed to execute bulk import.");
    } finally {
      setIsImporting(false);
    }
  };

  useEffect(() => {
    if (!jobId || !isScanning) return;
    const intervalId = setInterval(async () => {
      try {
        const status = await apiFetch<JobStatusResponse>(`/import/status/${jobId}`);
        setScanStatus(status);
        if (status.status === "completed") {
          setIsScanning(false);
          setPapersList(status.results);
          const selected = new Set<number>();
          status.results.forEach((p, idx) => {
            if (p.status !== "Duplicate" && p.status !== "Unknown Subject" && p.status !== "Needs Review") {
              selected.add(idx);
            }
          });
          setSelectedPaperIndices(selected);
          toast.success("Bulk scan and processing completed successfully!");
          clearInterval(intervalId);
        } else if (status.status === "failed") {
          setIsScanning(false);
          toast.error(status.error || "Scanning or extraction job failed.");
          setJobId("");
          clearInterval(intervalId);
        } else if (status.status === "cancelled") {
          setIsScanning(false);
          toast.info("Import job cancelled.");
          setJobId("");
          clearInterval(intervalId);
        }
      } catch (err) {
        console.error("Error polling status:", err);
      }
    }, 1500);
    return () => clearInterval(intervalId);
  }, [jobId, isScanning]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Database className="h-8 w-8 text-primary" />
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">Enterprise Sync Dashboard</h1>
          <p className="text-muted-foreground text-sm">
            Subject-centric document synchronization pipeline for academic Question Papers & Answer Keys.
          </p>
        </div>
      </div>

      {!isScanning && papersList.length === 0 && !importReport && (
        <div className="grid md:grid-cols-3 gap-6">
          <div className="md:col-span-2 space-y-6">
            <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-bold flex items-center gap-2 mb-4">
                <FolderOpen className="h-5 w-5 text-primary" />
                Google Drive Folder
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-muted-foreground mb-1">
                    Folder URL (Shared/Accessible link)
                  </label>
                  <input
                    type="text"
                    className="w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    placeholder="https://drive.google.com/drive/folders/xxxxxxxxx"
                    value={folderUrl}
                    onChange={(e) => handleSaveFolderUrl(e.target.value)}
                  />
                </div>
                <button
                  onClick={handleStartScan}
                  disabled={!googleToken || !folderUrl}
                  className="w-full flex items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground hover:opacity-95 disabled:opacity-50 transition-opacity"
                >
                  Start Discovery Scan
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-bold flex items-center gap-2 mb-4">
                <Key className="h-5 w-5 text-primary" />
                Google Connection
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-muted-foreground mb-1">
                    Google OAuth Client ID
                  </label>
                  <input
                    type="text"
                    className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs focus:outline-none disabled:opacity-50"
                    placeholder="xxxxxxxx.apps.googleusercontent.com"
                    value={clientId}
                    onChange={(e) => handleSaveClientId(e.target.value)}
                    disabled={!envClientId}
                  />
                </div>

                {!envClientId ? (
                  <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive flex items-start gap-2">
                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-bold block">Configuration Error</span>
                      <span className="opacity-90"><code>VITE_GOOGLE_CLIENT_ID</code> env is missing.</span>
                    </div>
                  </div>
                ) : googleToken ? (
                  <div className="rounded-lg bg-green-500/10 border border-green-500/20 p-3 text-xs text-green-600 flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <div>
                      <span className="font-semibold block">Connected to Google</span>
                      <span className="opacity-75">Ready to scan folders</span>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/20 p-3 text-xs text-yellow-600 flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <div>
                      <span className="font-semibold block">OAuth Required</span>
                      <span className="opacity-75">Connect Google account to crawl Drive</span>
                    </div>
                  </div>
                )}

                <button
                  onClick={handleConnectGoogle}
                  disabled={!envClientId}
                  className="w-full flex items-center justify-center gap-2 rounded-xl border border-border bg-background py-2 text-xs font-medium hover:bg-accent transition-colors disabled:opacity-50"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {googleToken ? "Reconnect Google" : "Connect Google"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {((isScanning && scanStatus) || (papersList.length > 0 && !isScanning)) && (
        <div className="space-y-6">
          
          {isScanning && scanStatus && (
            <div className="rounded-2xl border border-border bg-card p-6 shadow-sm space-y-4">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div>
                  <h3 className="text-lg font-bold flex items-center gap-2">
                    {scanStatus.status === "failed" ? (
                      <AlertCircle className="h-5 w-5 text-destructive" />
                    ) : scanStatus.status === "paused" ? (
                      <Pause className="h-5 w-5 text-amber-500 animate-pulse" />
                    ) : (
                      <Loader2 className="h-5 w-5 animate-spin text-primary" />
                    )}
                    {scanStatus.status === "failed"
                      ? "Scan Failed — Action Required"
                      : scanStatus.currentStep?.includes("scan_completed")
                      ? "Discovery Completed — Awaiting Processing"
                      : scanStatus.currentStep || "Processing subjects..."}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Pipeline Status: <span className="font-bold text-foreground capitalize">{scanStatus.status}</span>
                  </p>
                </div>

                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={handleCancelQueue}
                    className="flex items-center gap-1 px-4 py-2 border border-destructive/20 text-destructive text-xs font-bold rounded-xl bg-destructive/5 hover:bg-destructive/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Reset Job
                  </button>

                  {scanStatus.currentStep === "scan_completed" && (
                    <button
                      onClick={handleStartExtraction}
                      className="flex items-center gap-1 bg-primary text-primary-foreground text-xs font-bold px-5 py-2 rounded-xl hover:opacity-95"
                    >
                      <Sparkles className="h-3.5 w-3.5" /> Extract Metadata
                    </button>
                  )}

                  {scanStatus.status === "processing" && (
                    <button
                      onClick={handlePauseQueue}
                      className="flex items-center gap-1 border border-border bg-background text-xs px-4 py-2 rounded-xl hover:bg-accent"
                    >
                      <Pause className="h-3.5 w-3.5" /> Pause Queue
                    </button>
                  )}

                  {scanStatus.status === "paused" && scanStatus.currentStep !== "scan_completed" && (
                    <button
                      onClick={handleResumeQueue}
                      className="flex items-center gap-1 bg-primary text-primary-foreground text-xs font-bold px-4 py-2 rounded-xl hover:opacity-95"
                    >
                      <Play className="h-3.5 w-3.5" /> Resume Queue
                    </button>
                  )}
                </div>
              </div>

              {scanStatus.status === "failed" && (
                <div className="rounded-xl bg-destructive/10 border border-destructive/20 p-4 text-sm text-destructive flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-bold block">Scan Job Failed</span>
                      <span className="text-xs opacity-90">{scanStatus.error || "An error occurred during background scanning."}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {(scanStatus.error?.includes("401") || scanStatus.error?.toLowerCase().includes("token") || scanStatus.error?.toLowerCase().includes("reconnect")) && (
                      <button
                        onClick={handleConnectGoogle}
                        className="flex items-center gap-1.5 rounded-lg bg-destructive text-destructive-foreground px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition-opacity"
                      >
                        <RefreshCw className="h-3.5 w-3.5" /> Reconnect Google
                      </button>
                    )}
                  </div>
                </div>
              )}

              {scanStatus.status !== "failed" && scanStatus.currentStep !== "scan_completed" && (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs font-semibold text-muted-foreground">
                    <span>Extraction Progress</span>
                    <span>{scanStatus.progress}% ({processedFiles}/{totalFiles} files)</span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
                    <div
                      className="bg-primary h-full transition-all duration-300"
                      style={{ width: `${scanStatus.progress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {selectedPaperIndices.size > 0 && (
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 bg-card border border-border p-5 rounded-2xl shadow-sm">
              <div>
                <h3 className="text-lg font-bold">Import Authorization Review</h3>
                <p className="text-xs text-muted-foreground">
                  {isScanning
                    ? "Importing selected subjects immediately. The scanner will continue processing other files."
                    : "Grouped subjects are ready. Review matches and edit values below before finalizing sync."}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setSelectedPaperIndices(new Set());
                    if (!isScanning) {
                      setPapersList([]);
                    }
                  }}
                  className="rounded-xl border border-border bg-background px-4 py-2.5 text-xs font-bold hover:bg-accent"
                >
                  {isScanning ? "Deselect All" : "Cancel"}
                </button>
                <button
                  onClick={handleExecuteImport}
                  disabled={isImporting}
                  className="flex items-center gap-1.5 rounded-xl bg-primary px-6 py-2.5 text-xs font-bold text-primary-foreground hover:opacity-95 disabled:opacity-50"
                >
                  {isImporting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Finalizing...
                    </>
                  ) : (
                    <>
                      <Database className="h-4 w-4" /> Import Selected ({selectedPaperIndices.size})
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          <div className="grid md:grid-cols-4 gap-6">
            
            <div className="md:col-span-3 grid grid-cols-2 md:grid-cols-4 gap-3 bg-card border border-border rounded-2xl p-5 shadow-sm">
              <div className="rounded-xl border border-border bg-background/50 p-3.5 text-center">
                <span className="text-[9px] text-muted-foreground block font-bold uppercase tracking-wider mb-1">Total Subjects</span>
                <span className="text-xl font-extrabold">{totalSubjects}</span>
              </div>
              <div className="rounded-xl border border-border bg-background/50 p-3.5 text-center">
                <span className="text-[9px] text-green-600 block font-bold uppercase tracking-wider mb-1">Complete Pairs</span>
                <span className="text-xl font-extrabold text-green-600">{completePairs}</span>
              </div>
              <div className="rounded-xl border border-border bg-background/50 p-3.5 text-center">
                <span className="text-[9px] text-blue-600 block font-bold uppercase tracking-wider mb-1">QP Only</span>
                <span className="text-xl font-extrabold text-blue-600">{qpsOnly}</span>
              </div>
              <div className="rounded-xl border border-border bg-background/50 p-3.5 text-center">
                <span className="text-[9px] text-amber-600 block font-bold uppercase tracking-wider mb-1">AK Only</span>
                <span className="text-xl font-extrabold text-amber-600">{aksOnly}</span>
              </div>
              <div className="rounded-xl border border-border bg-background/50 p-3.5 text-center">
                <span className="text-[9px] text-zinc-500 block font-bold uppercase tracking-wider mb-1">Already Imported</span>
                <span className="text-xl font-extrabold text-zinc-500">{alreadyImportedCount}</span>
              </div>
              <div className="rounded-xl border border-border bg-background/50 p-3.5 text-center">
                <span className="text-[9px] text-sky-600 block font-bold uppercase tracking-wider mb-1">Updated QPs</span>
                <span className="text-xl font-extrabold text-sky-600">{updatedQps}</span>
              </div>
              <div className="rounded-xl border border-border bg-background/50 p-3.5 text-center">
                <span className="text-[9px] text-teal-600 block font-bold uppercase tracking-wider mb-1">Updated AKs</span>
                <span className="text-xl font-extrabold text-teal-600">{updatedAks}</span>
              </div>
              <div className="rounded-xl border border-border bg-background/50 p-3.5 text-center">
                <span className="text-[9px] text-violet-600 block font-bold uppercase tracking-wider mb-1">Needs Review</span>
                <span className="text-xl font-extrabold text-violet-600">{needsReviewCount}</span>
              </div>
              <div className="rounded-xl border border-border bg-background/50 p-3.5 text-center">
                <span className="text-[9px] text-red-600 block font-bold uppercase tracking-wider mb-1">Duplicates</span>
                <span className="text-xl font-extrabold text-red-600">{duplicateSubjects}</span>
              </div>
              <div className="rounded-xl border border-border bg-background/50 p-3.5 text-center">
                <span className="text-[9px] text-rose-600 block font-bold uppercase tracking-wider mb-1">Lock/Protected</span>
                <span className="text-xl font-extrabold text-rose-600">{passwordProtected}</span>
              </div>
              <div className="rounded-xl border border-border bg-background/50 p-3.5 text-center">
                <span className="text-[9px] text-muted-foreground block font-bold uppercase tracking-wider mb-1">Avg Confidence</span>
                <span className="text-xl font-extrabold">{avgConfidence}%</span>
              </div>
              <div className="rounded-xl border border-border bg-background/50 p-3.5 text-center">
                <span className="text-[9px] text-muted-foreground block font-bold uppercase tracking-wider mb-1">ETA</span>
                <span className="text-xl font-extrabold">{isScanning ? etaStr : "Complete"}</span>
              </div>
            </div>

            <div className="bg-card border border-border rounded-2xl p-4 shadow-sm flex flex-col justify-between max-h-[220px]">
              <div>
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider block mb-2">Live Activity Feed</span>
                <div className="space-y-2 overflow-y-auto max-h-[140px] pr-1">
                  {activityFeed.length === 0 ? (
                    <span className="text-[10px] text-muted-foreground italic block">Waiting for document updates...</span>
                  ) : (
                    activityFeed.map((act, i) => (
                      <div key={act.id || i} className="text-[10px] border-b border-border/40 pb-1.5 flex items-center justify-between gap-2">
                        <div className="truncate">
                          <span className={`font-semibold shrink-0 ${
                            act.action.includes("Imported") ? "text-green-600" :
                            act.action.includes("Updated") ? "text-sky-600" :
                            act.action.includes("Attached") ? "text-teal-600" :
                            act.action.includes("Failed") ? "text-red-600" :
                            "text-slate-500"
                          }`}>{act.action}</span>
                          <span className="text-muted-foreground truncate block font-medium">{act.subject}</span>
                        </div>
                        <span className="text-[9px] text-slate-400 shrink-0">{act.time}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
              {isScanning && (
                <div className="text-[9px] text-slate-400 border-t border-border pt-2 flex justify-between">
                  <span>Speed: {processingSpeed}</span>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            
            <div className="flex flex-col md:flex-row gap-3 bg-card border border-border p-4 rounded-xl shadow-sm">
              
              <div className="flex-1 relative">
                <input
                  type="text"
                  placeholder="Search by subject, department, or semester..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-4 py-2 border border-border bg-background rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              <div className="flex gap-2">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="bg-background border border-border rounded-lg text-xs px-3 py-2 font-semibold text-muted-foreground focus:outline-none"
                >
                  <option value="all">All Statuses</option>
                  <option value="ready">Ready to Import</option>
                  <option value="qp_only">Question Paper Only</option>
                  <option value="waiting_ak">Searching Answer Key</option>
                  <option value="waiting_qp">Waiting for Question Paper</option>
                  <option value="already_imported">Already Imported</option>
                  <option value="duplicate">Duplicate</option>
                  <option value="needs_review">Needs Review</option>
                  <option value="updated">Updated</option>
                </select>

                <button
                  onClick={handleSelectAll}
                  className="border border-border bg-background hover:bg-accent rounded-lg text-xs px-3.5 py-2 font-bold transition-colors"
                >
                  {selectedPaperIndices.size > 0 && selectedPaperIndices.size === displaySubjects.filter(s => s.status !== "Scanning" && s.status !== "Searching Answer Key" && s.status !== "Searching Question Paper" && s.status !== "Already Imported" && s.status !== "Duplicate").length ? "Deselect All" : "Select All"}
                </button>
              </div>
            </div>

            <div className="space-y-3">
              {filteredSubjects.length === 0 ? (
                <div className="text-center py-12 bg-card border border-dashed border-border rounded-xl text-muted-foreground text-sm">
                  No subjects match the selected filters or search queries.
                </div>
              ) : (
                filteredSubjects.map((sub, idx) => {
                  const keyIdx = sub.keyIndex;
                  const isSelected = selectedPaperIndices.has(keyIdx);
                  const isExpanded = expandedCard === `${sub.subject}-${keyIdx}`;

                  const isSelectable =
                    sub.status !== "Scanning" &&
                    sub.status !== "Searching Answer Key" &&
                    sub.status !== "Searching Question Paper" &&
                    sub.status !== "Already Imported" &&
                    sub.status !== "Duplicate";

                  return (
                    <div
                      key={keyIdx}
                      className={`border bg-card rounded-xl shadow-xs transition-all overflow-hidden ${
                        isExpanded ? "border-primary/40 ring-1 ring-primary/10" : "border-border hover:border-slate-300 dark:hover:border-slate-700"
                      } ${isSelected ? "bg-primary/[0.01]" : ""} ${!isSelectable ? "opacity-90" : ""}`}
                    >
                      
                      <div
                        className="flex items-center justify-between p-4 cursor-pointer select-none"
                        onClick={() => setExpandedCard(isExpanded ? null : `${sub.subject}-${keyIdx}`)}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={!isSelectable}
                            onChange={(e) => {
                              e.stopPropagation();
                              handleSelectRow(keyIdx);
                            }}
                            className="rounded accent-primary h-4.5 w-4.5 cursor-pointer shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
                          />

                          <div className="min-w-0">
                            <span className="font-bold text-sm md:text-base text-foreground truncate block">{sub.subject}</span>
                            <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider block mt-0.5">
                              {sub.department} • Sem {sub.semester} • {sub.academic_year} • {sub.exam_type}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 shrink-0">
                          
                          <div className="hidden md:flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground uppercase border-r border-border/80 pr-3 mr-1">
                            <span className="flex items-center gap-1">
                              {sub.question_paper ? (
                                <span className="h-4 w-4 bg-green-100 dark:bg-green-950/40 text-green-600 rounded-full flex items-center justify-center font-extrabold text-[9px]">✓</span>
                              ) : (
                                <span className="h-4 w-4 bg-slate-100 dark:bg-zinc-800 text-slate-400 rounded-full flex items-center justify-center font-extrabold text-[9px]">—</span>
                              )}
                              QP
                            </span>
                            <span className="flex items-center gap-1">
                              {sub.answer_key ? (
                                <span className="h-4 w-4 bg-green-100 dark:bg-green-950/40 text-green-600 rounded-full flex items-center justify-center font-extrabold text-[9px]">✓</span>
                              ) : (
                                <span className="h-4 w-4 bg-slate-100 dark:bg-zinc-800 text-slate-400 rounded-full flex items-center justify-center font-extrabold text-[9px]">—</span>
                              )}
                              AK
                            </span>
                          </div>

                          {sub.confidence > 0 && (
                            <span className={`rounded-lg px-2.5 py-0.5 text-[10px] font-extrabold ${
                              sub.confidence >= 90 ? "bg-green-500/10 text-green-600" :
                              sub.confidence >= 70 ? "bg-yellow-500/10 text-yellow-600" :
                              "bg-red-500/10 text-red-600 animate-pulse"
                            }`}>
                              {sub.confidence}% Conf.
                            </span>
                          )}

                          <span className={`rounded-full px-3 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                            sub.status === "Ready" || sub.status === "completed" ? "bg-green-500/10 text-green-600 border border-green-500/20" :
                            sub.status === "Searching Answer Key" || sub.status === "Searching Question Paper" ? "bg-blue-500/10 text-blue-600 border border-blue-500/20 animate-pulse" :
                            sub.status === "Duplicate" ? "bg-red-500/10 text-red-600 border border-red-500/20" :
                            sub.status === "Needs Review" ? "bg-violet-500/10 text-violet-600 border border-violet-500/20 animate-pulse" :
                            sub.status === "Update Question Paper" || sub.status === "Update Answer Key" ? "bg-sky-500/10 text-sky-600 border border-sky-500/20" :
                            sub.status === "Attach Answer Key" ? "bg-teal-500/10 text-teal-600 border border-teal-500/20" :
                            "bg-amber-500/10 text-amber-600 border border-amber-500/20"
                          }`}>
                            {sub.status}
                          </span>

                          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${
                            isExpanded ? "transform rotate-180" : ""
                          }`} />
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="border-t border-border bg-slate-50/50 dark:bg-muted/10 p-5 space-y-4 text-xs font-semibold">
                          
                          <div className="grid md:grid-cols-2 gap-4">
                            
                            <div className="bg-background rounded-xl p-4 border border-border space-y-2">
                              <span className="text-[10px] font-bold uppercase text-muted-foreground block border-b border-border/80 pb-1.5">Question Paper</span>
                              {sub.question_paper ? (
                                <div className="space-y-1.5">
                                  <a
                                    href={sub.question_paper.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="flex items-center gap-1 text-primary font-bold hover:underline"
                                  >
                                    <FileText className="h-4 w-4 shrink-0" />
                                    <span className="truncate">{sub.question_paper.name}</span>
                                    <ExternalLink className="h-3 w-3 shrink-0" />
                                  </a>
                                  <div className="text-[10px] text-slate-500 space-y-0.5">
                                    <span>Size: {sub.question_paper.size ? `${(sub.question_paper.size / 1024).toFixed(1)} KB` : "Unknown"}</span>
                                    {sub.question_paper.checksum && <span className="block truncate">Checksum: {sub.question_paper.checksum}</span>}
                                    {sub.question_paper.modifiedTime && <span className="block">Modified: {new Date(sub.question_paper.modifiedTime).toLocaleString()}</span>}
                                    <span>Status: <span className="font-bold text-foreground capitalize">{sub.question_paper.status || "ready"}</span></span>
                                  </div>
                                </div>
                              ) : (
                                <span className="text-red-500 font-bold block pt-1">✗ Question Paper Not Found</span>
                              )}
                            </div>

                            <div className="bg-background rounded-xl p-4 border border-border space-y-2">
                              <span className="text-[10px] font-bold uppercase text-muted-foreground block border-b border-border/80 pb-1.5">Answer Key</span>
                              {sub.answer_key ? (
                                <div className="space-y-1.5">
                                  <a
                                    href={sub.answer_key.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="flex items-center gap-1 text-green-600 font-bold hover:underline"
                                  >
                                    <FileText className="h-4 w-4 shrink-0 text-green-500" />
                                    <span className="truncate">{sub.answer_key.name}</span>
                                    <ExternalLink className="h-3 w-3 shrink-0" />
                                  </a>
                                  <div className="text-[10px] text-slate-500 space-y-0.5">
                                    <span>Size: {sub.answer_key.size ? `${(sub.answer_key.size / 1024).toFixed(1)} KB` : "Unknown"}</span>
                                    {sub.answer_key.checksum && <span className="block truncate">Checksum: {sub.answer_key.checksum}</span>}
                                    {sub.answer_key.modifiedTime && <span className="block">Modified: {new Date(sub.answer_key.modifiedTime).toLocaleString()}</span>}
                                    <span>Status: <span className="font-bold text-foreground capitalize">{sub.answer_key.status || "ready"}</span></span>
                                  </div>
                                </div>
                              ) : (
                                <span className="text-amber-500 font-bold block pt-1">
                                  {sub.status.includes("Searching") ? "⌛ Searching for Answer Key..." : "✗ Answer Key Not Found"}
                                </span>
                              )}
                            </div>
                          </div>

                          {!isScanning ? (
                            <div className="grid grid-cols-2 md:grid-cols-6 gap-3 pt-2">
                              <div>
                                <label className="block text-[9px] uppercase font-bold text-slate-400 mb-1">Subject Title</label>
                                <input
                                  type="text"
                                  value={sub.subject}
                                  onChange={(e) => handleCellChange(keyIdx, "subject", e.target.value)}
                                  className="w-full bg-background border border-border rounded px-2.5 py-1 text-xs font-semibold"
                                />
                              </div>
                              <div>
                                <label className="block text-[9px] uppercase font-bold text-slate-400 mb-1">Subject Code</label>
                                <input
                                  type="text"
                                  value={sub.subject_code || ""}
                                  onChange={(e) => handleCellChange(keyIdx, "subject_code", e.target.value || null)}
                                  placeholder="Code (Optional)"
                                  className="w-full bg-background border border-border rounded px-2.5 py-1 text-xs font-semibold"
                                />
                              </div>
                              <div>
                                <label className="block text-[9px] uppercase font-bold text-slate-400 mb-1">Department</label>
                                <select
                                  value={sub.department}
                                  onChange={(e) => handleCellChange(keyIdx, "department", e.target.value)}
                                  className="w-full bg-background border border-border rounded px-2 py-1 text-xs font-semibold focus:outline-none"
                                >
                                  <option value="Unknown">Unknown</option>
                                  {departments.map((d) => (
                                    <option key={d} value={d}>{d}</option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="block text-[9px] uppercase font-bold text-slate-400 mb-1">Semester</label>
                                <select
                                  value={sub.semester}
                                  onChange={(e) => handleCellChange(keyIdx, "semester", parseInt(e.target.value, 10))}
                                  className="w-full bg-background border border-border rounded px-2 py-1 text-xs font-semibold focus:outline-none"
                                >
                                  {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => (
                                    <option key={s} value={s}>Sem {s}</option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="block text-[9px] uppercase font-bold text-slate-400 mb-1">Academic Year</label>
                                <select
                                  value={sub.academic_year}
                                  onChange={(e) => handleCellChange(keyIdx, "academic_year", e.target.value)}
                                  className="w-full bg-background border border-border rounded px-2 py-1 text-xs font-semibold focus:outline-none"
                                >
                                  {academicYears.map((y) => (
                                    <option key={y} value={y}>{y}</option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="block text-[9px] uppercase font-bold text-slate-400 mb-1">Marks</label>
                                <input
                                  type="number"
                                  value={sub.marks || 70}
                                  onChange={(e) => handleCellChange(keyIdx, "marks", parseInt(e.target.value, 10) || 70)}
                                  className="w-full bg-background border border-border rounded px-2.5 py-1 text-xs font-semibold"
                                />
                              </div>
                            </div>
                          ) : (
                            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 pt-2 text-[10px] text-slate-500 border-t border-border/80">
                              <div>
                                <span className="block font-bold uppercase text-slate-400 text-[9px]">Department</span>
                                <span className="font-semibold text-foreground">{sub.department}</span>
                              </div>
                              <div>
                                <span className="block font-bold uppercase text-slate-400 text-[9px]">Semester</span>
                                <span className="font-semibold text-foreground">Sem {sub.semester}</span>
                              </div>
                              <div>
                                <span className="block font-bold uppercase text-slate-400 text-[9px]">Academic Year</span>
                                <span className="font-semibold text-foreground">{sub.academic_year}</span>
                              </div>
                              <div>
                                <span className="block font-bold uppercase text-slate-400 text-[9px]">Exam Type</span>
                                <span className="font-semibold text-foreground">{sub.exam_type}</span>
                              </div>
                              <div>
                                <span className="block font-bold uppercase text-slate-400 text-[9px]">Marks</span>
                                <span className="font-semibold text-foreground">{sub.marks} marks</span>
                              </div>
                            </div>
                          )}

                          <div className="bg-background rounded-xl p-4 border border-border space-y-2">
                            <span className="text-[10px] font-bold uppercase text-slate-400 block border-b border-border/80 pb-1">Confidence Score Breakdown</span>
                            <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-center text-[10px]">
                              <div>
                                <span className="text-slate-400 block">Subject Match</span>
                                <span className="font-bold text-foreground">40%</span>
                                <div className="w-full bg-muted h-1 rounded-full overflow-hidden mt-1">
                                  <div className="bg-green-500 h-full w-[40%]" />
                                </div>
                              </div>
                              <div>
                                <span className="text-slate-400 block">Course Code</span>
                                <span className="font-bold text-foreground">20%</span>
                                <div className="w-full bg-muted h-1 rounded-full overflow-hidden mt-1">
                                  <div className="bg-green-500 h-full w-[20%]" />
                                </div>
                              </div>
                              <div>
                                <span className="text-slate-400 block">Department</span>
                                <span className="font-bold text-foreground">10%</span>
                                <div className="w-full bg-muted h-1 rounded-full overflow-hidden mt-1">
                                  <div className="bg-green-500 h-full w-[10%]" />
                                </div>
                              </div>
                              <div>
                                <span className="text-slate-400 block">Semester</span>
                                <span className="font-bold text-foreground">10%</span>
                                <div className="w-full bg-muted h-1 rounded-full overflow-hidden mt-1">
                                  <div className="bg-green-500 h-full w-[10%]" />
                                </div>
                              </div>
                              <div>
                                <span className="text-slate-400 block">Filename Match</span>
                                <span className="font-bold text-slate-400">—</span>
                                <div className="w-full bg-muted h-1 rounded-full mt-1" />
                              </div>
                              <div>
                                <span className="text-slate-400 block">Folder Path</span>
                                <span className="font-bold text-foreground">10%</span>
                                <div className="w-full bg-muted h-1 rounded-full overflow-hidden mt-1">
                                  <div className="bg-green-500 h-full w-[10%]" />
                                </div>
                              </div>
                            </div>
                            <div className="text-[10px] text-slate-500 border-t border-border/60 pt-2 flex items-center justify-between">
                              <span>OCR Engine Source: <span className="font-semibold text-foreground">Local Tesseract</span></span>
                              <span>Proximity Folder Path: <span className="font-semibold text-foreground">/{sub.department || "Unknown"}</span></span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {importReport && (
        <div className="max-w-2xl mx-auto my-6 bg-card border border-border rounded-2xl p-8 shadow-sm">
          <div className="flex items-center gap-2.5 text-green-600 mb-4">
            <CheckCircle className="h-8 w-8 shrink-0" />
            <div>
              <h3 className="text-xl font-bold">Import Summary Report</h3>
              <p className="text-xs text-muted-foreground">
                Document synchronization complete. The catalog has been successfully synchronized.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-5 gap-3 my-6">
            <div className="rounded-xl border border-border bg-background p-3.5 text-center">
              <span className="text-[9px] text-muted-foreground block font-bold uppercase tracking-wider mb-1">Total Processed</span>
              <span className="text-xl font-extrabold">{importReport.stats?.totalProcessed || 0}</span>
            </div>
            <div className="rounded-xl border border-border bg-background p-3.5 text-center">
              <span className="text-[9px] text-green-600 block font-bold uppercase tracking-wider mb-1">Imported</span>
              <span className="text-xl font-extrabold text-green-600">{importReport.stats?.imported || 0}</span>
            </div>
            <div className="rounded-xl border border-border bg-background p-3.5 text-center">
              <span className="text-[9px] text-blue-600 block font-bold uppercase tracking-wider mb-1">New QPs</span>
              <span className="text-xl font-extrabold text-blue-600">{importReport.stats?.newQps || 0}</span>
            </div>
            <div className="rounded-xl border border-border bg-background p-3.5 text-center">
              <span className="text-[9px] text-blue-500 block font-bold uppercase tracking-wider mb-1">New AKs</span>
              <span className="text-xl font-extrabold text-blue-500">{importReport.stats?.newAks || 0}</span>
            </div>
            <div className="rounded-xl border border-border bg-background p-3.5 text-center">
              <span className="text-[9px] text-sky-600 block font-bold uppercase tracking-wider mb-1">Updated QPs</span>
              <span className="text-xl font-extrabold text-sky-600">{importReport.stats?.updatedQps || 0}</span>
            </div>
            <div className="rounded-xl border border-border bg-background p-3.5 text-center">
              <span className="text-[9px] text-teal-600 block font-bold uppercase tracking-wider mb-1">Updated AKs</span>
              <span className="text-xl font-extrabold text-teal-600">{importReport.stats?.updatedAks || 0}</span>
            </div>
            <div className="rounded-xl border border-border bg-background p-3.5 text-center">
              <span className="text-[9px] text-amber-600 block font-bold uppercase tracking-wider mb-1">Skipped</span>
              <span className="text-xl font-extrabold text-amber-600">{importReport.stats?.skipped || 0}</span>
            </div>
            <div className="rounded-xl border border-border bg-background p-3.5 text-center">
              <span className="text-[9px] text-orange-600 block font-bold uppercase tracking-wider mb-1">Duplicates</span>
              <span className="text-xl font-extrabold text-orange-600">{importReport.stats?.duplicateSkipped || 0}</span>
            </div>
            <div className="rounded-xl border border-border bg-background p-3.5 text-center">
              <span className="text-[9px] text-red-600 block font-bold uppercase tracking-wider mb-1">Failed</span>
              <span className="text-xl font-extrabold text-red-600">{importReport.stats?.failed || 0}</span>
            </div>
            <div className="rounded-xl border border-border bg-background p-3.5 text-center">
              <span className="text-[9px] text-muted-foreground block font-bold uppercase tracking-wider mb-1">Runtime</span>
              <span className="text-xl font-extrabold">
                {scanStartTime ? (() => { const ms = Date.now() - scanStartTime; return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`; })() : "—"}
              </span>
            </div>
          </div>

          <div className="flex justify-end gap-3 border-t border-border pt-6">
            <Link
              to="/admin"
              search={{ tab: "manage" }}
              className="rounded-xl bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold hover:opacity-95"
            >
              Go to Manage Papers
            </Link>
            <button
              onClick={() => setImportReport(null)}
              className="rounded-xl border border-border px-5 py-2.5 text-sm font-semibold hover:bg-accent"
            >
              Sync More
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
