import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Sparkles, Bot, Mic, MicOff, Send, CheckCircle2, XCircle, Loader2, Clock, ShieldCheck, Volume2, VolumeX, Ban, FileText, Wrench, ThumbsUp, ThumbsDown, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { API_ORIGIN } from "@/lib/config";

export const Route = createFileRoute("/_app/ops")({ component: OpsPage });

const API = `${API_ORIGIN}/api/ops`;
const token = () => localStorage.getItem("auth_token") || "";
async function call(path: string, method = "GET", body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403 && /token/i.test(json.error || "")) {
    throw new Error("Your login session is invalid or expired. Click Sign out, then sign in again.");
  }
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

type Task = { key: string; agent: string; title: string; deps: string[]; status: string; attempts: number; start_ms: number | null; end_ms: number | null; duration_ms: number | null; error: any; output: any; gate: string | null };
type Snapshot = { id: string; status: string; request: string; intent: any; strategy: string; strategy_reason: string; plan_version: string; tasks: Task[]; approval: any; summary: any; error: any; notes: string[]; tool_calls: any[]; metrics: any };
type Suggestion = { label: string; say: string; kind: "ask" | "action" | "approve" | "reject" | "ui" };
type Option = { kind: string; id: string; label: string };
type Msg = { role: "user" | "agent"; text: string; wf?: string; suggestions?: Suggestion[]; options?: Option[] };

const SCENARIOS = [
  "Find employee E102's assigned laptop. Check its details and assignment history, identify a compatible replacement from available inventory, prepare the replacement workflow, and show me what needs approval.",
  "E201's laptop is overheating, replace it",
  "E301's plotter is broken, find a replacement",
  "Show details for asset AAI-XYZ-999",
  "How many laptops are available in stock?",
];

const AGENT_COLORS: Record<string, string> = {
  asset_intel: "bg-sky-500", logistics: "bg-amber-500", diagnostics: "bg-violet-500",
  execution: "bg-emerald-600", verification: "bg-rose-500",
};
const AGENT_NAMES: Record<string, string> = {
  asset_intel: "Asset Intelligence", logistics: "Logistics", diagnostics: "Diagnostics", execution: "Execution", verification: "Verification",
};

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    SUCCEEDED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    RUNNING: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
    WAITING_FOR_APPROVAL: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    WAITING_FOR_INPUT: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    FAILED: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
    CANCELLED: "bg-muted text-muted-foreground", SKIPPED: "bg-muted text-muted-foreground", PENDING: "bg-muted text-muted-foreground",
  };
  return <span className={cn("px-2 py-0.5 rounded text-[11px] font-semibold whitespace-nowrap", map[status] || "bg-muted")}>{status.replace(/_/g, " ")}</span>;
}

function TaskIcon({ status }: { status: string }) {
  if (status === "SUCCEEDED") return <CheckCircle2 className="size-4 text-emerald-600" />;
  if (status === "FAILED") return <XCircle className="size-4 text-rose-600" />;
  if (status === "RUNNING") return <Loader2 className="size-4 text-sky-600 animate-spin" />;
  if (status === "WAITING_FOR_APPROVAL") return <ShieldCheck className="size-4 text-amber-600" />;
  return <Clock className="size-4 text-muted-foreground" />;
}

// --- Browser speech (Web Speech API: Chrome/Edge). Text input always works as fallback.
function useSpeech(onFinal: (t: string) => void) {
  const recRef = useRef<any>(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const SR = typeof window !== "undefined" ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;
  // Embedded Chromium (Electron apps such as the Claude desktop pane) exposes the API but has no
  // Google speech key, so recognition always fails with a "network" error there.
  const embedded = typeof navigator !== "undefined" && /Electron|Claude\//.test(navigator.userAgent);
  const ERRORS: Record<string, string> = {
    "not-allowed": "Microphone blocked. Click the lock icon in the address bar, allow Microphone, then try again.",
    "service-not-allowed": "Microphone blocked by the browser. Allow it in site settings.",
    "network": "Speech service unreachable. Voice needs Google Chrome or Microsoft Edge with internet access (not an embedded/app browser).",
    "audio-capture": "No microphone found. Check that a mic is connected and selected in Windows sound settings.",
    "no-speech": "Didn't hear anything. Click the mic and speak right away.",
  };
  const start = () => {
    setVoiceError("");
    if (!SR) { setVoiceError("This browser has no speech recognition. Open http://localhost:8080/ops in Chrome or Edge, or type instead."); return; }
    if (embedded) { setVoiceError(ERRORS.network); return; }
    window.speechSynthesis?.cancel(); // barge-in: stop speaking when the user talks
    const rec = new SR();
    rec.lang = "en-IN"; rec.interimResults = true; rec.continuous = false;
    rec.onresult = (e: any) => {
      let text = "", final = "";
      for (const r of e.results) (r.isFinal ? (final += r[0].transcript) : (text += r[0].transcript));
      setInterim(text || final);
      if (final) { setInterim(""); onFinal(final.trim()); }
    };
    rec.onend = () => setListening(false);
    rec.onerror = (e: any) => { setListening(false); if (e.error !== "aborted") setVoiceError(ERRORS[e.error] || `Voice error: ${e.error}`); };
    recRef.current = rec;
    try { rec.start(); setListening(true); } catch (e: any) { setVoiceError(`Could not start the microphone: ${e.message}`); }
  };
  const stop = () => { recRef.current?.stop(); setListening(false); };
  return { supported: Boolean(SR), listening, interim, start, stop, voiceError };
}

function OpsPage() {
  const [messages, setMessages] = useState<Msg[]>([{ role: "agent", text: "AirportOps AI ready. Ask by voice or text, e.g. \"E102's laptop is broken, replace it\"." }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [wf, setWf] = useState<Snapshot | null>(null);
  const [pending, setPending] = useState<Snapshot | null>(null); // approval stays visible while follow-ups run
  const [persisted, setPersisted] = useState<any>(null);
  const [strategy, setStrategy] = useState("parallel");
  const [tts, setTts] = useState(true);
  const [tab, setTab] = useState("timeline");
  const [error, setError] = useState("");
  const convId = useRef(`conv-${Date.now()}`);
  const spokenFor = useRef<string>("");
  const streamAbort = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const speak = (text: string) => {
    if (!tts || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05; window.speechSynthesis.speak(u);
  };

  const refreshPersisted = async (id: string) => {
    try { setPersisted((await call(`/workflows/${id}`)).persisted); } catch { /* ignore */ }
  };

  const follow = async (id: string) => {
    streamAbort.current?.abort();
    const ac = new AbortController();
    streamAbort.current = ac;
    try {
      const res = await fetch(`${API}/workflows/${id}/stream`, { headers: { Authorization: `Bearer ${token()}` }, signal: ac.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const ev = chunk.match(/^event: (.*)$/m)?.[1];
          const data = chunk.match(/^data: (.*)$/m)?.[1];
          if (!ev || !data) continue;
          if (ev === "snapshot") {
            const snap: Snapshot = JSON.parse(data);
            setWf(snap);
            setPending(p => (snap.status === "WAITING_FOR_APPROVAL" ? snap : p?.id === snap.id ? null : p));
            const key = `${snap.id}:${snap.status}`;
            if (snap.summary && snap.summary.status === snap.status && spokenFor.current !== key && !["RUNNING", "PENDING"].includes(snap.status)) {
              spokenFor.current = key;
              const q = snap.error?.details?.question;
              setMessages(m => [...m, { role: "agent", wf: snap.id, text: [snap.summary.headline, q && q !== snap.summary.headline ? q : null].filter(Boolean).join("\n"), suggestions: snap.summary.suggestions, options: snap.summary.options || undefined }]);
              speak(snap.summary.speech);
              refreshPersisted(snap.id);
            }
          }
        }
      }
    } catch { /* aborted or disconnected */ }
  };

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setInput(""); setError(""); setBusy(true);
    setMessages(m => [...m, { role: "user", text: t }]);
    try {
      const r = await call("/converse", "POST", { text: t, conversation_id: convId.current, strategy });
      setMessages(m => [...m, { role: "agent", text: r.reply, wf: r.workflow_id }]);
      if (r.workflow_id) { setPersisted(null); follow(r.workflow_id); setTab("timeline"); }
    } catch (e: any) {
      setError(e.message);
      setMessages(m => [...m, { role: "agent", text: `Error: ${e.message}` }]);
    } finally { setBusy(false); }
  };

  const speech = useSpeech(send);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => () => streamAbort.current?.abort(), []);

  const decide = async (action: "approve" | "reject" | "cancel", target?: Snapshot) => {
    const w = target || wf;
    if (!w) return;
    setError("");
    try {
      await call(`/workflows/${w.id}/${action}`, "POST", {});
      if (action !== "cancel") setPending(null);
      setMessages(m => [...m, { role: "user", text: action === "approve" ? "Approved." : action === "reject" ? "Rejected." : "Cancel." }]);
      follow(w.id);
    } catch (e: any) { setError(e.message); }
  };

  return (
    <div className="p-6 h-full flex flex-col gap-4 min-h-0">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Bot className="size-6 text-primary" /> AirportOps AI</h1>
          <p className="text-sm text-muted-foreground">Multi-agent IT operations over MCP. Every change needs approval and is checked against the database afterwards.</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Strategy</span>
          <select className="border rounded-md px-2 py-1 bg-background" value={strategy} onChange={e => setStrategy(e.target.value)}>
            <option value="parallel">Parallel (DAG)</option>
            <option value="sequential">Sequential</option>
            <option value="auto">Auto (from history)</option>
          </select>
          <Button variant="outline" size="sm" onClick={() => { setTts(!tts); window.speechSynthesis?.cancel(); }}>
            {tts ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 flex-1 min-h-0">
        {/* Conversation */}
        <Card className="lg:col-span-2 flex flex-col min-h-[480px]">
          <CardHeader className="pb-2"><CardTitle className="text-base">Conversation</CardTitle></CardHeader>
          <CardContent className="flex-1 flex flex-col gap-3 min-h-0">
            <div className="flex-1 overflow-y-auto space-y-2 pr-1 min-h-0 max-h-[55vh]">
              {messages.map((m, i) => {
                const latest = i === messages.length - 1;
                return (
                  <div key={i} className={cn("max-w-[92%]", m.role === "user" && "ml-auto")}>
                    <div className={cn("rounded-lg px-3 py-2 text-sm whitespace-pre-wrap", m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted")}>{m.text}</div>
                    {m.options && m.options.length > 0 && (
                      <div className="mt-1.5 grid gap-1.5">
                        {m.options.map((o, n) => (
                          <button key={o.id} disabled={!latest || busy} onClick={() => send(o.id)}
                            className={cn("text-left text-xs border rounded-md px-3 py-2 transition-colors flex items-center gap-2", latest ? "hover:bg-primary hover:text-primary-foreground border-primary/40 bg-card" : "opacity-50")}>
                            <span className="size-5 rounded-full bg-primary/10 text-primary grid place-items-center text-[10px] font-bold shrink-0">{n + 1}</span>{o.label}
                          </button>
                        ))}
                      </div>
                    )}
                    {latest && m.suggestions && m.suggestions.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5 items-center">
                        <Sparkles className="size-3.5 text-primary" />
                        {m.suggestions.map(sg => (
                          <button key={sg.say} disabled={busy}
                            onClick={() => (sg.say.startsWith("__tab:") ? setTab(sg.say.slice(6)) : send(sg.say))}
                            className={cn("text-[11px] rounded-full px-2.5 py-1 border font-medium transition-colors",
                              sg.kind === "approve" && "bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700",
                              sg.kind === "reject" && "border-rose-400 text-rose-700 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950",
                              sg.kind === "action" && "border-primary text-primary hover:bg-primary hover:text-primary-foreground",
                              (sg.kind === "ask" || sg.kind === "ui") && "bg-card hover:bg-muted")}>
                            {sg.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {speech.interim && <div className="ml-auto rounded-lg px-3 py-2 text-sm italic opacity-70 bg-primary/20">{speech.interim}…</div>}
              <div ref={endRef} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SCENARIOS.map(s => (
                <button key={s} onClick={() => send(s)} disabled={busy} className="text-[11px] border rounded-full px-2.5 py-1 hover:bg-muted text-left">
                  {s.length > 48 ? s.slice(0, 48) + "…" : s}
                </button>
              ))}
            </div>
            {wf?.status === "WAITING_FOR_APPROVAL" && <div className="text-xs text-muted-foreground">Say or type "approve" or "reject".</div>}
            <form className="flex gap-2" onSubmit={e => { e.preventDefault(); send(input); }}>
              <Button type="button" variant={speech.listening ? "destructive" : "outline"} size="icon"
                title="Speak (Chrome or Edge)" onClick={() => (speech.listening ? speech.stop() : speech.start())}>
                {speech.listening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
              </Button>
              <Input value={input} onChange={e => setInput(e.target.value)} placeholder={speech.listening ? "Listening…" : "Describe the problem or ask a question"} />
              <Button type="submit" disabled={busy || !input.trim()}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}</Button>
            </form>
            {speech.listening && <div className="text-xs text-sky-600 flex items-center gap-1"><Mic className="size-3.5 animate-pulse" />Listening… speak now</div>}
            {speech.voiceError && <div className="text-xs text-amber-700 dark:text-amber-400">{speech.voiceError}</div>}
            {error && <div className="text-xs text-rose-600">{error}</div>}
          </CardContent>
        </Card>

        {/* Workflow */}
        <Card className="lg:col-span-3 flex flex-col min-h-[480px]">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <CardTitle className="text-base">Workflow</CardTitle>
              {wf && <div className="flex items-center gap-2"><StatusPill status={wf.status} />
                {["RUNNING", "WAITING_FOR_APPROVAL"].includes(wf.status) && <Button size="sm" variant="ghost" onClick={() => decide("cancel")}><Ban className="size-4 mr-1" />Cancel</Button>}
              </div>}
            </div>
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto">
            {!wf ? (
              <div className="h-full grid place-items-center text-sm text-muted-foreground text-center p-8">No workflow yet. Pick a scenario or ask a question.</div>
            ) : (
              <div className="space-y-4">
                <Metrics wf={wf} />
                {wf.summary && (
                  <div className={cn("rounded-md border p-3 text-sm", wf.status === "FAILED" && "border-rose-300 bg-rose-50 dark:bg-rose-950/30", wf.status === "SUCCEEDED" && "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30")}>
                    <div className="font-medium">{wf.summary.headline}</div>
                    {wf.summary.lines?.map((l: string, i: number) => <div key={i} className="text-muted-foreground text-xs mt-1">{l}</div>)}
                  </div>
                )}
                {wf.status === "WAITING_FOR_APPROVAL" && wf.approval && <ApprovalCard wf={wf} onDecide={a => decide(a, wf)} />}
                {pending && pending.id !== wf.id && pending.approval && (
                  <div className="space-y-1">
                    <div className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-2">Still waiting for your decision: {pending.summary?.headline}
                      <button className="underline" onClick={() => follow(pending.id)}>view</button></div>
                    <ApprovalCard wf={pending} onDecide={a => decide(a, pending)} />
                  </div>
                )}
                <Tabs value={tab} onValueChange={setTab}>
                  <TabsList className="flex-wrap h-auto">
                    <TabsTrigger value="timeline">Timeline</TabsTrigger>
                    <TabsTrigger value="plan">Plan</TabsTrigger>
                    <TabsTrigger value="records">Records</TabsTrigger>
                    <TabsTrigger value="tools">MCP calls ({wf.tool_calls.length})</TabsTrigger>
                    <TabsTrigger value="verify">Verification</TabsTrigger>
                    <TabsTrigger value="report">Report</TabsTrigger>
                    <TabsTrigger value="trace">Trace</TabsTrigger>
                  </TabsList>
                  <TabsContent value="timeline"><Timeline wf={wf} /></TabsContent>
                  <TabsContent value="plan"><PlanView wf={wf} /></TabsContent>
                  <TabsContent value="records"><Records wf={wf} /></TabsContent>
                  <TabsContent value="tools"><ToolCalls wf={wf} /></TabsContent>
                  <TabsContent value="verify"><Verification wf={wf} /></TabsContent>
                  <TabsContent value="report"><Report wf={wf} persisted={persisted} /></TabsContent>
                  <TabsContent value="trace"><pre className="text-[11px] bg-muted rounded p-3 overflow-auto max-h-96">{JSON.stringify({ intent: wf.intent, strategy: wf.strategy, strategy_reason: wf.strategy_reason, plan_version: wf.plan_version, error: wf.error, notes: wf.notes, metrics: wf.metrics, events: persisted?.events?.length }, null, 2)}</pre></TabsContent>
                </Tabs>
                {["SUCCEEDED", "FAILED", "CANCELLED"].includes(wf.status) && <Feedback id={wf.id} />}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Metrics({ wf }: { wf: Snapshot }) {
  const m = wf.metrics || {};
  const items = [
    ["Agent time", m.agent_ms != null ? `${m.agent_ms} ms` : "-"],
    ["First action", m.first_action_ms != null ? `${m.first_action_ms} ms` : "-"],
    ["Ready for approval", m.approval_ready_ms != null ? `${m.approval_ready_ms} ms` : "-"],
    ["MCP calls", m.tool_calls ?? 0],
    ["DB queries", m.db_queries ?? 0],
    ["LLM calls", m.llm_calls ?? 0],
    ["Retries", m.retries ?? 0],
  ];
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-2">
      {items.map(([k, v]) => (
        <div key={k as string} className="rounded-md border px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</div>
          <div className="text-sm font-semibold tabular-nums">{v}</div>
        </div>
      ))}
    </div>
  );
}

function Timeline({ wf }: { wf: Snapshot }) {
  const max = Math.max(1, ...wf.tasks.map(t => t.end_ms ?? t.start_ms ?? 0));
  return (
    <div className="space-y-1.5 mt-2">
      {wf.tasks.map(t => {
        const left = ((t.start_ms ?? 0) / max) * 100;
        const width = t.start_ms != null ? Math.max(1.5, (((t.end_ms ?? max) - t.start_ms) / max) * 100) : 0;
        return (
          <div key={t.key} className="grid grid-cols-[20px_minmax(140px,1.2fr)_2fr_70px] items-center gap-2 text-xs">
            <TaskIcon status={t.status} />
            <div className="truncate" title={t.title}>
              <div className="font-medium truncate">{t.title}</div>
              <div className="text-[10px] text-muted-foreground">{AGENT_NAMES[t.agent] || t.agent}{t.attempts > 1 ? ` · ${t.attempts} attempts` : ""}</div>
            </div>
            <div className="relative h-4 bg-muted rounded">
              {width > 0 && <div className={cn("absolute h-4 rounded", AGENT_COLORS[t.agent] || "bg-primary", t.status === "FAILED" && "bg-rose-600")} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} />}
            </div>
            <div className="text-right tabular-nums">{t.duration_ms != null ? `${t.duration_ms} ms` : <StatusPill status={t.status} />}</div>
            {t.error && <div className="col-span-4 text-[11px] text-rose-600 pl-7">{t.error.code}: {t.error.message}</div>}
          </div>
        );
      })}
      <div className="flex flex-wrap gap-3 pt-2 text-[10px] text-muted-foreground">
        {Object.entries(AGENT_NAMES).map(([k, n]) => <span key={k} className="flex items-center gap-1"><span className={cn("size-2 rounded-sm", AGENT_COLORS[k])} />{n}</span>)}
      </div>
    </div>
  );
}

function PlanView({ wf }: { wf: Snapshot }) {
  const depth: Record<string, number> = {};
  const d = (k: string): number => depth[k] ?? (depth[k] = Math.max(0, ...(wf.tasks.find(t => t.key === k)?.deps || []).map(x => d(x) + 1)));
  wf.tasks.forEach(t => d(t.key));
  const levels = Math.max(0, ...Object.values(depth)) + 1;
  return (
    <div className="mt-2 space-y-2">
      <div className="text-xs text-muted-foreground">{wf.plan_version} · strategy <b>{wf.strategy}</b> ({wf.strategy_reason}). Tasks in the same column run at the same time.</div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {Array.from({ length: levels }, (_, lvl) => (
          <div key={lvl} className="flex flex-col gap-2 min-w-[150px]">
            <div className="text-[10px] uppercase text-muted-foreground">Stage {lvl + 1}</div>
            {wf.tasks.filter(t => depth[t.key] === lvl).map(t => (
              <div key={t.key} className="border rounded-md p-2 text-xs">
                <div className="flex items-center gap-1.5"><TaskIcon status={t.status} /><span className="font-medium">{t.key}</span></div>
                <div className="text-[10px] text-muted-foreground mt-0.5">{AGENT_NAMES[t.agent]}</div>
                {t.deps.length > 0 && <div className="text-[10px] mt-1">← {t.deps.join(", ")}</div>}
                {t.gate && <Badge variant="outline" className="mt-1 text-[10px]">needs approval</Badge>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function AssetCard({ a, label }: { a: any; label: string }) {
  if (!a) return null;
  return (
    <div className="border rounded-md p-3 text-xs space-y-1">
      <div className="flex items-center justify-between"><span className="text-[10px] uppercase text-muted-foreground">{label}</span>{a.synthetic && <Badge variant="outline" className="text-[10px]">synthetic demo</Badge>}</div>
      <Link to="/assets/$id" params={{ id: a.asset_id }} className="font-semibold text-primary hover:underline">{a.asset_id}</Link>
      <div>{[a.make, a.model].filter(Boolean).join(" ")} · {a.type}</div>
      <div className="text-muted-foreground">{a.status} · {a.location || "no location"}</div>
      {(a.specs?.ram || a.ram) && <div>{a.specs?.ram || a.ram} RAM · {a.specs?.storage || a.storage} · {a.specs?.os || a.os}</div>}
      {a.warranty_end_date && <div>Warranty until {a.warranty_end_date} {a.warranty_valid === false && <span className="text-rose-600">(expired)</span>}</div>}
      {a.score != null && <div className="text-emerald-700 dark:text-emerald-400">Score {a.score}: {a.reasons?.join(", ")}</div>}
    </div>
  );
}

function Records({ wf }: { wf: Snapshot }) {
  const out = (k: string) => wf.tasks.find(t => t.key === k)?.output;
  const emp = out("resolve_identity")?.employee;
  const sel = out("select_replacement");
  const diag = out("diagnostics");
  const inv = out("inventory_scan");
  const hist = out("assignment_history");
  return (
    <div className="mt-2 space-y-3">
      {emp && (
        <div className="border rounded-md p-3 text-xs">
          <div className="text-[10px] uppercase text-muted-foreground">Employee</div>
          <Link to="/users/$id" params={{ id: emp.user_id }} className="font-semibold text-primary hover:underline">{emp.emp_id} · {emp.employee_name}</Link>
          <div className="text-muted-foreground">{emp.department} · {emp.location} · {emp.active_assets?.length} assigned asset(s)</div>
        </div>
      )}
      <div className="grid sm:grid-cols-2 gap-2">
        <AssetCard a={out("asset_details")} label="Affected device" />
        <AssetCard a={sel?.selected} label={`Selected replacement (${sel?.rules || ""})`} />
      </div>
      {sel?.rejected?.length > 0 && <div className="text-[11px] text-muted-foreground">Rejected: {sel.rejected.map((r: any) => `${r.asset_id} (${r.reasons.join(", ")})`).join("; ")}</div>}
      {inv && <div className="text-xs">Inventory: <b>{inv.available_count}</b> available {inv.asset_type}(s)</div>}
      {diag && (
        <div className="border rounded-md p-3 text-xs space-y-1.5">
          <div className="font-medium flex items-center gap-1"><Wrench className="size-3.5" /> Diagnostics</div>
          <div><b>Facts (from records):</b><ul className="list-disc pl-4">{diag.facts.map((f: any, i: number) => <li key={i}>{f.fact} <span className="text-muted-foreground">[{f.source}]</span></li>)}</ul></div>
          {diag.hypotheses.length > 0 && <div><b>Hypotheses (unverified):</b><ul className="list-disc pl-4">{diag.hypotheses.map((h: any, i: number) => <li key={i}>{h.text} <span className="text-muted-foreground">({h.confidence})</span></li>)}</ul></div>}
          <div><b>Steps:</b><ul className="list-disc pl-4">{diag.recommended_steps.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul></div>
          {diag.escalation.recommended && <div className="text-amber-700 flex gap-1"><AlertTriangle className="size-3.5" />Escalate: {diag.escalation.reason}</div>}
          <div className="text-[10px] text-muted-foreground">{diag.disclaimer}</div>
        </div>
      )}
      {hist && (
        <div className="text-xs">
          <div className="font-medium mb-1">History ({hist.entries.length})</div>
          <div className="max-h-40 overflow-y-auto border rounded">
            {hist.entries.map((h: any) => <div key={h.history_id} className="px-2 py-1 border-b last:border-0 flex gap-2"><span className="tabular-nums text-muted-foreground w-20 shrink-0">{h.assigned_date || h.returned_date}</span><span className="w-20 shrink-0">{h.status}</span><span className="truncate">{h.remarks}</span></div>)}
          </div>
        </div>
      )}
      {wf.error?.details?.options && <div className="text-xs">Options: {wf.error.details.options.map((o: any) => o.label).join(" | ")}</div>}
      {!emp && !inv && !out("asset_details") && <div className="text-xs text-muted-foreground">No records retrieved.</div>}
    </div>
  );
}

function ApprovalCard({ wf, onDecide }: { wf: Snapshot; onDecide: (a: "approve" | "reject") => void }) {
  return (
    <div className="rounded-md border-2 border-amber-400 p-3 space-y-2">
      <div className="font-semibold text-sm flex items-center gap-2"><ShieldCheck className="size-4 text-amber-600" />Approval required</div>
      {wf.approval.actions.map((a: any, i: number) => (
        <div key={i} className="text-xs bg-muted rounded p-2">
          <div className="font-mono font-semibold">{a.tool}</div>
          {a.tool === "replace_asset" ? (
            <div>Withdraw <b>{a.args.old_asset_id}</b> (set to {a.args.old_asset_status}) and assign <b>{a.args.new_asset_id}</b> to <b>{a.args.user_id}</b> in one transaction.</div>
          ) : a.tool === "create_employee" ? (
            <div>Create employee <b>{a.args.emp_id}</b> · <b>{a.args.employee_name}</b>{a.args.email ? ` · ${a.args.email}` : ""} (status Active).</div>
          ) : <pre className="text-[11px]">{JSON.stringify(a.args, null, 1)}</pre>}
        </div>
      ))}
      <div className="text-[11px] text-muted-foreground">Dry run passed and was rolled back. Nothing has changed yet. Replacement is on hold for 30 min.</div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => onDecide("approve")}><CheckCircle2 className="size-4 mr-1" />Approve & execute</Button>
        <Button size="sm" variant="outline" onClick={() => onDecide("reject")}><XCircle className="size-4 mr-1" />Reject</Button>
      </div>
    </div>
  );
}

function ToolCalls({ wf }: { wf: Snapshot }) {
  return (
    <div className="mt-2 border rounded text-xs overflow-x-auto">
      <table className="w-full">
        <thead className="bg-muted text-[10px] uppercase"><tr><th className="text-left p-1.5">t</th><th className="text-left p-1.5">Tool</th><th className="text-left p-1.5">Task</th><th className="p-1.5">Result</th><th className="text-right p-1.5">Round trip</th><th className="text-right p-1.5">Server</th><th className="text-right p-1.5">DB q</th></tr></thead>
        <tbody>
          {wf.tool_calls.map((c, i) => (
            <tr key={i} className="border-t" title={JSON.stringify(c.args)}>
              <td className="p-1.5 tabular-nums">{c.t}ms</td><td className="p-1.5 font-mono">{c.tool}</td><td className="p-1.5">{c.task}</td>
              <td className="p-1.5 text-center">{c.ok ? <CheckCircle2 className="size-3.5 text-emerald-600 inline" /> : <span className="text-rose-600">{c.error_code}</span>}</td>
              <td className="p-1.5 text-right tabular-nums">{c.client_ms}ms</td><td className="p-1.5 text-right tabular-nums">{c.server_ms}ms</td><td className="p-1.5 text-right">{c.db_queries}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Verification({ wf }: { wf: Snapshot }) {
  const t = wf.tasks.find(x => x.key === "verify");
  const v = t?.output || t?.error?.details;
  if (!v) return <div className="text-xs text-muted-foreground mt-2">{t ? `Verification ${t.status.toLowerCase().replace(/_/g, " ")}.` : "This workflow changes no records, so there is nothing to verify."}</div>;
  return (
    <div className="mt-2 space-y-1">
      <div className={cn("text-sm font-semibold", v.passed ? "text-emerald-700" : "text-rose-700")}>{v.passed ? "All checks passed against persisted records" : "Verification FAILED"}</div>
      {v.checks.map((c: any, i: number) => (
        <div key={i} className="flex items-start gap-2 text-xs">{c.pass ? <CheckCircle2 className="size-4 text-emerald-600 shrink-0" /> : <XCircle className="size-4 text-rose-600 shrink-0" />}<div>{c.name}<div className="text-[10px] text-muted-foreground font-mono">{JSON.stringify(c.evidence)}</div></div></div>
      ))}
    </div>
  );
}

function Report({ wf, persisted }: { wf: Snapshot; persisted: any }) {
  const r = wf.tasks.find(t => t.key === "handover_report")?.output?.content || persisted?.report?.content;
  if (!r) return <div className="text-xs text-muted-foreground mt-2">The handover report is created after the change is executed and verified.</div>;
  return (
    <div className="mt-2 border rounded-md p-4 text-xs space-y-2" id="handover-report">
      <div className="flex items-center justify-between"><div className="font-semibold text-sm flex items-center gap-1"><FileText className="size-4" />{r.title}</div><Button size="sm" variant="outline" onClick={() => window.print()}>Print</Button></div>
      <div className="text-muted-foreground">Workflow {r.workflow_id} · {new Date(r.generated_at).toLocaleString()}{r.synthetic && " · SYNTHETIC DEMO DATA"}</div>
      <div><b>Employee:</b> {r.employee.emp_id} {r.employee.name}, {r.employee.department}, {r.employee.location}</div>
      <div className="grid sm:grid-cols-2 gap-2"><AssetCard a={r.issued_asset} label="Issued" /><AssetCard a={r.returned_asset} label="Returned" /></div>
      {r.approval && <div><b>Approved by</b> {r.approval.decided_by} at {r.approval.decided_at}</div>}
      {r.diagnostics_summary && <div className="whitespace-pre-wrap"><b>Diagnostics:</b>{"\n"}{r.diagnostics_summary}</div>}
      <div><b>Audit entries:</b> {r.history_entries.map((h: any) => `#${h.history_id} ${h.asset_id} ${h.status}`).join(", ")}</div>
      <div><b>Checklist:</b><ul className="list-disc pl-4">{r.checklist.map((c: string) => <li key={c}>{c}</li>)}</ul></div>
    </div>
  );
}

function Feedback({ id }: { id: string }) {
  const [sent, setSent] = useState("");
  const [comment, setComment] = useState("");
  const submit = async (rating: string) => {
    try { await call(`/workflows/${id}/feedback`, "POST", { rating, comment }); setSent(rating); } catch (e: any) { setSent(`error: ${e.message}`); }
  };
  if (sent) return <div className="text-xs text-muted-foreground">Feedback recorded: {sent}. Thanks.</div>;
  return (
    <div className="flex items-center gap-2 flex-wrap text-xs border-t pt-3">
      <span className="text-muted-foreground">Was this result right?</span>
      <Button size="sm" variant="outline" onClick={() => submit("correct")}><ThumbsUp className="size-3.5 mr-1" />Correct</Button>
      <Button size="sm" variant="outline" onClick={() => submit("incomplete")}>Incomplete</Button>
      <Button size="sm" variant="outline" onClick={() => submit("incorrect")}><ThumbsDown className="size-3.5 mr-1" />Incorrect</Button>
      <Input className="h-8 max-w-xs" placeholder="Optional comment" value={comment} onChange={e => setComment(e.target.value)} />
    </div>
  );
}
