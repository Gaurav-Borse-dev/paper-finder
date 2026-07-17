import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  FolderOpen, Key, RefreshCw, CheckCircle2, AlertCircle, Loader2,
  Database, FileText, ArrowRight, Sparkles, CheckCircle
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
  } | null;
  answer_key: {
    id: string;
    name: string;
    url: string;
  } | null;
  status: "Ready" | "Missing Answer Key" | "Duplicate" | "Unknown Subject" | "Unknown Semester";
  dbPaperId?: string;
  duplicateResolution?: "skip" | "replace" | "update";
  error?: string | null;
}

interface JobStatusResponse {
  id: string;
  status: "scanning" | "processing" | "completed" | "failed";
  currentStep: string;
  progress: number;
  stats: {
    totalFiles: number;
    questionPapers: number;
    answerKeys: number;
    matchedPapers: number;
    missingAnswerKeys: number;
    duplicates: number;
    unknownFiles: number;
  };
  results: ImportPaperItem[];
  error?: string;
}

function BulkImport() {
  // Settings & Auth States
  const [googleToken, setGoogleToken] = useState<string>(() => localStorage.getItem("gdrive_access_token") || "");
  const [clientId, setClientId] = useState<string>(() => {
    return import.meta.env.VITE_GOOGLE_CLIENT_ID || localStorage.getItem("gdrive_client_id") || "";
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

  // Fetch database lookups on mount
  useEffect(() => {
    fetchLookup<{ name: string }>("departments")
      .then((data) => setDepartments(data.map((d) => d.name)))
      .catch(console.error);
    fetchLookup<{ name: string }>("exam_types")
      .then((data) => setExamTypes(data.map((e) => e.name)))
      .catch(console.error);
    fetchLookup<{ name: string }>("academic_years")
      .then((data) => setAcademicYears(data.map((y) => y.name)))
      .catch(console.error);
    fetchLookup<{ name: string }>("subjects")
      .then((data) => setSubjects(data.map((s) => s.name)))
      .catch(console.error);
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

  // Google OAuth Auth trigger
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
        error_callback: (err: any) => {
          console.error("OAuth error:", err);
          toast.error("Google Authentication failed");
        },
      });
      tokenClient.requestAccessToken({ prompt: "consent" });
    } catch (err) {
      console.error("Failed to init token client:", err);
      toast.error("Failed to initialize Google Authentication. Verify Client ID.");
    }
  };

  // Scan Folder initiation
  const handleStartScan = async () => {
    if (!folderUrl) {
      toast.error("Please input a Google Drive Folder URL.");
      return;
    }
    if (!googleToken) {
      toast.error("Please connect your Google Drive account first.");
      return;
    }

    setImportReport(null);
    setIsScanning(true);
    setScanStatus(null);
    setPapersList([]);
    setSelectedPaperIndices(new Set());

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

  // Poll job status
  useEffect(() => {
    if (!jobId || !isScanning) return;

    let intervalId = setInterval(async () => {
      try {
        const status = await apiFetch<JobStatusResponse>(`/import/status/${jobId}`);
        setScanStatus(status);

        if (status.status === "completed") {
          setIsScanning(false);
          setPapersList(status.results);
          // Select everything by default except duplicates
          const selected = new Set<number>();
          status.results.forEach((p, idx) => {
            if (p.status !== "Duplicate" && p.status !== "Unknown Subject") {
              selected.add(idx);
            }
          });
          setSelectedPaperIndices(selected);
          toast.success("Scan completed! Ready for review.");
          clearInterval(intervalId);
        } else if (status.status === "failed") {
          setIsScanning(false);
          toast.error(status.error || "Scanning job failed.");
          clearInterval(intervalId);
        }
      } catch (err) {
        console.error("Error polling job status:", err);
      }
    }, 1500);

    return () => clearInterval(intervalId);
  }, [jobId, isScanning]);

  // Handle cell edit in grid
  const handleCellChange = (index: number, key: keyof ImportPaperItem, value: any) => {
    setPapersList((prev) => {
      const copy = [...prev];
      const updatedItem = { ...copy[index], [key]: value };

      // Update status dynamically if relevant fields are fixed
      if (updatedItem.status === "Unknown Subject" && key === "subject" && value !== "Unknown Subject") {
        updatedItem.status = updatedItem.answer_key ? "Ready" : "Missing Answer Key";
      }

      copy[index] = updatedItem;
      return copy;
    });
  };

  // Handle bulk action (execute imports)
  const handleExecuteImport = async () => {
    const papersToImport = papersList.filter((_, idx) => selectedPaperIndices.has(idx));
    if (papersToImport.length === 0) {
      toast.error("No papers selected for import.");
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
      // Reset scanning data so they can see the report
      setPapersList([]);
      setJobId("");
      setScanStatus(null);
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Failed to execute bulk import.");
    } finally {
      setIsImporting(false);
    }
  };

  const handleSelectRow = (index: number) => {
    setSelectedPaperIndices((prev) => {
      const copy = new Set(prev);
      if (copy.has(index)) {
        copy.delete(index);
      } else {
        copy.add(index);
      }
      return copy;
    });
  };

  const handleSelectAll = () => {
    if (selectedPaperIndices.size === papersList.length) {
      setSelectedPaperIndices(new Set());
    } else {
      setSelectedPaperIndices(new Set(papersList.keys()));
    }
  };

  // Auth is handled by the parent admin layout

  return (
    <div>
        <div className="flex items-center gap-3 mb-6">
          <Database className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight">AI Bulk Import System</h1>
            <p className="text-muted-foreground text-sm">
              Scan Google Drive folders recursively, extract metadata, pair files, and import hundreds of papers automatically.
            </p>
          </div>
        </div>

        {/* Dashboard Configuration Grid */}
        {!isScanning && papersList.length === 0 && !importReport && (
          <div className="grid md:grid-cols-3 gap-6">
            <div className="md:col-span-2 space-y-6">
              {/* Folder URL Form */}
              <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
                <h2 className="text-lg font-bold flex items-center gap-2 mb-4">
                  <FolderOpen className="h-5 w-5 text-primary" />
                  Google Drive Folder
                </h2>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-muted-foreground mb-1">
                      Folder URL (Must be shared or accessible)
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
                    Scan Folder
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Google OAuth & Config Settings Column */}
            <div className="space-y-6">
              {/* Google Connection state card */}
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
                      className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs focus:outline-none"
                      placeholder="xxxxxxxx.apps.googleusercontent.com"
                      value={clientId}
                      onChange={(e) => handleSaveClientId(e.target.value)}
                    />
                  </div>

                  {googleToken ? (
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
                        <span className="opacity-75">Connect Google account to list files</span>
                      </div>
                    </div>
                  )}

                  <button
                    onClick={handleConnectGoogle}
                    className="w-full flex items-center justify-center gap-2 rounded-xl border border-border bg-background py-2 text-xs font-medium hover:bg-accent transition-colors"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {googleToken ? "Reconnect Google Drive" : "Connect Google Drive"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Dynamic Progress Screen */}
        {isScanning && scanStatus && (
          <div className="max-w-xl mx-auto my-12 bg-card border border-border rounded-2xl p-8 shadow-sm">
            <h3 className="text-xl font-bold mb-1 flex items-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              Scanning Google Drive Folder...
            </h3>
            <p className="text-xs text-muted-foreground mb-6">
              Processing nested structures. This may take a few minutes for larger folders.
            </p>

            <div className="space-y-6">
              {/* Progress Bar */}
              <div>
                <div className="flex items-center justify-between text-xs font-medium mb-1">
                  <span>Progress</span>
                  <span>{scanStatus.progress}%</span>
                </div>
                <div className="w-full bg-muted rounded-full h-2">
                  <div
                    className="bg-primary h-2 rounded-full transition-all duration-300"
                    style={{ width: `${scanStatus.progress}%` }}
                  />
                </div>
              </div>

              {/* Status details */}
              <div className="rounded-xl bg-accent p-4 border border-border">
                <span className="text-xs text-muted-foreground block uppercase font-bold tracking-wider mb-1">
                  Current Step
                </span>
                <p className="text-sm font-semibold flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary animate-pulse" />
                  {scanStatus.currentStep}
                </p>
              </div>

              {/* Real-time stats */}
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-lg border border-border bg-background p-3">
                  <span className="text-muted-foreground block">Files Found</span>
                  <span className="text-lg font-bold">{scanStatus.stats?.totalFiles || 0}</span>
                </div>
                <div className="rounded-lg border border-border bg-background p-3">
                  <span className="text-muted-foreground block">Processed</span>
                  <span className="text-lg font-bold">
                    {(scanStatus.stats?.questionPapers || 0) + (scanStatus.stats?.answerKeys || 0) + (scanStatus.stats?.unknownFiles || 0)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Editable Review Screen */}
        {papersList.length > 0 && !isScanning && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold">Import Review</h2>
                <p className="text-xs text-muted-foreground">
                  Review matched papers and resolve duplicates before saving. Check checkboxes to import.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPapersList([])}
                  className="rounded-xl border border-border bg-background px-4 py-2 text-xs font-semibold hover:bg-accent"
                >
                  Cancel
                </button>
                <button
                  onClick={handleExecuteImport}
                  disabled={isImporting || selectedPaperIndices.size === 0}
                  className="flex items-center gap-1.5 rounded-xl bg-primary px-5 py-2 text-xs font-semibold text-primary-foreground hover:opacity-95 disabled:opacity-50"
                >
                  {isImporting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Importing...
                    </>
                  ) : (
                    <>
                      <Database className="h-4 w-4" />
                      Import Selected ({selectedPaperIndices.size})
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Grid Review Table */}
            <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-xs font-semibold text-muted-foreground uppercase">
                    <th className="p-3 text-center w-10">
                      <input
                        type="checkbox"
                        checked={selectedPaperIndices.size === papersList.length}
                        onChange={handleSelectAll}
                        className="rounded accent-primary"
                      />
                    </th>
                    <th className="p-3 w-48">Subject</th>
                    <th className="p-3 w-32">Department</th>
                    <th className="p-3 w-24">Sem</th>
                    <th className="p-3 w-28">Year</th>
                    <th className="p-3 w-28">Exam Type</th>
                    <th className="p-3 w-20">Marks</th>
                    <th className="p-3">QP PDF</th>
                    <th className="p-3">AK PDF</th>
                    <th className="p-3 w-36">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border font-medium">
                  {papersList.map((paper, idx) => {
                    const isSelected = selectedPaperIndices.has(idx);
                    return (
                      <tr
                        key={idx}
                        className={`hover:bg-accent/40 transition-colors ${
                          isSelected ? "bg-primary/5" : ""
                        }`}
                      >
                        <td className="p-3 text-center">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => handleSelectRow(idx)}
                            className="rounded accent-primary"
                          />
                        </td>

                        {/* Subject */}
                        <td className="p-2">
                          <input
                            type="text"
                            value={paper.subject}
                            onChange={(e) => handleCellChange(idx, "subject", e.target.value)}
                            className="w-full bg-transparent border-0 border-b border-transparent focus:border-primary hover:border-border px-1 py-0.5 text-sm font-semibold focus:outline-none"
                          />
                        </td>

                        {/* Department */}
                        <td className="p-2">
                          <select
                            value={paper.department}
                            onChange={(e) => handleCellChange(idx, "department", e.target.value)}
                            className="w-full bg-transparent border-0 border-b border-transparent focus:border-primary hover:border-border px-1 py-0.5 text-sm focus:outline-none"
                          >
                            <option value="Unknown">Unknown</option>
                            {departments.map((d) => (
                              <option key={d} value={d}>
                                {d}
                              </option>
                            ))}
                          </select>
                        </td>

                        {/* Sem */}
                        <td className="p-2">
                          <select
                            value={paper.semester}
                            onChange={(e) => handleCellChange(idx, "semester", parseInt(e.target.value, 10))}
                            className="w-full bg-transparent border-0 border-b border-transparent focus:border-primary hover:border-border px-1 py-0.5 text-sm focus:outline-none"
                          >
                            {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => (
                              <option key={s} value={s}>
                                Sem {s}
                              </option>
                            ))}
                          </select>
                        </td>

                        {/* Year */}
                        <td className="p-2">
                          <select
                            value={paper.academic_year}
                            onChange={(e) => handleCellChange(idx, "academic_year", e.target.value)}
                            className="w-full bg-transparent border-0 border-b border-transparent focus:border-primary hover:border-border px-1 py-0.5 text-xs focus:outline-none"
                          >
                            {academicYears.map((y) => (
                              <option key={y} value={y}>
                                {y}
                              </option>
                            ))}
                          </select>
                        </td>

                        {/* Exam Type */}
                        <td className="p-2">
                          <select
                            value={paper.exam_type}
                            onChange={(e) => handleCellChange(idx, "exam_type", e.target.value)}
                            className="w-full bg-transparent border-0 border-b border-transparent focus:border-primary hover:border-border px-1 py-0.5 text-xs focus:outline-none"
                          >
                            {examTypes.map((et) => (
                              <option key={et} value={et}>
                                {et}
                              </option>
                            ))}
                          </select>
                        </td>

                        {/* Marks */}
                        <td className="p-2">
                          <input
                            type="number"
                            value={paper.marks || 70}
                            onChange={(e) => handleCellChange(idx, "marks", parseInt(e.target.value, 10) || 70)}
                            className="w-full bg-transparent border-0 border-b border-transparent focus:border-primary hover:border-border px-1 py-0.5 text-sm focus:outline-none"
                          />
                        </td>

                        {/* QP URL */}
                        <td className="p-3 max-w-[120px] truncate text-xs text-muted-foreground">
                          {paper.question_paper ? (
                            <a
                              href={paper.question_paper.url}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center gap-1 hover:text-primary"
                            >
                              <FileText className="h-3 w-3 shrink-0 text-primary" />
                              <span className="truncate">{paper.question_paper.name}</span>
                            </a>
                          ) : (
                            <span className="text-destructive font-semibold">Missing</span>
                          )}
                        </td>

                        {/* AK URL */}
                        <td className="p-3 max-w-[120px] truncate text-xs text-muted-foreground">
                          {paper.answer_key ? (
                            <a
                              href={paper.answer_key.url}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center gap-1 hover:text-primary"
                            >
                              <FileText className="h-3 w-3 shrink-0 text-green-500" />
                              <span className="truncate">{paper.answer_key.name}</span>
                            </a>
                          ) : (
                            <span className="text-amber-500/80 font-medium">None</span>
                          )}
                        </td>

                        {/* Status/Resolution */}
                        <td className="p-2">
                          {paper.status === "Duplicate" ? (
                            <div className="flex flex-col gap-1">
                              <span className="inline-flex rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-600 border border-red-500/20 max-w-max">
                                Duplicate
                              </span>
                              <select
                                value={paper.duplicateResolution || "skip"}
                                onChange={(e) => handleCellChange(idx, "duplicateResolution", e.target.value)}
                                className="bg-background rounded border border-border text-[11px] px-1.5 py-0.5"
                              >
                                <option value="skip">Skip</option>
                                <option value="replace">Replace</option>
                                <option value="update">Update</option>
                              </select>
                            </div>
                          ) : paper.status === "Missing Answer Key" ? (
                            <span className="inline-flex rounded-full bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-amber-600 border border-amber-500/20">
                              No Answer Key
                            </span>
                          ) : paper.status === "Unknown Subject" ? (
                            <span className="inline-flex rounded-full bg-orange-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-orange-600 border border-orange-500/20">
                              Unknown Subject
                            </span>
                          ) : (
                            <span className="inline-flex rounded-full bg-green-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-green-600 border border-green-500/20">
                              Ready
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Final Report Screen */}
        {importReport && (
          <div className="max-w-2xl mx-auto my-6 bg-card border border-border rounded-2xl p-8 shadow-sm">
            <div className="flex items-center gap-2.5 text-green-600 mb-4">
              <CheckCircle className="h-8 w-8 shrink-0" />
              <div>
                <h3 className="text-xl font-bold">Import Completed!</h3>
                <p className="text-xs text-muted-foreground">
                  The papers have been successfully registered inside PaperVault.
                </p>
              </div>
            </div>

            {/* Stats list */}
            <div className="grid grid-cols-4 gap-4 my-6">
              <div className="rounded-xl border border-border bg-background p-4 text-center">
                <span className="text-[10px] text-muted-foreground block font-bold uppercase tracking-wider mb-1">
                  Total Processed
                </span>
                <span className="text-2xl font-extrabold">{importReport.stats?.totalProcessed || 0}</span>
              </div>
              <div className="rounded-xl border border-border bg-background p-4 text-center">
                <span className="text-[10px] text-green-600 block font-bold uppercase tracking-wider mb-1">
                  Imported
                </span>
                <span className="text-2xl font-extrabold text-green-600">{importReport.stats?.imported || 0}</span>
              </div>
              <div className="rounded-xl border border-border bg-background p-4 text-center">
                <span className="text-[10px] text-amber-600 block font-bold uppercase tracking-wider mb-1">
                  Skipped
                </span>
                <span className="text-2xl font-extrabold text-amber-600">{importReport.stats?.skipped || 0}</span>
              </div>
              <div className="rounded-xl border border-border bg-background p-4 text-center">
                <span className="text-[10px] text-red-600 block font-bold uppercase tracking-wider mb-1">
                  Failed
                </span>
                <span className="text-2xl font-extrabold text-red-600">{importReport.stats?.failed || 0}</span>
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
                Import More
              </button>
            </div>
          </div>
        )}
    </div>
  );
}
