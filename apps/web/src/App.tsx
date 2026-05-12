import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MarkdownEditor } from "markdown-wysiwyg-editor";
import { useEffect, useMemo, useState } from "react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import {
  createPage,
  deletePage,
  fetchHealth,
  fetchPage,
  fetchPageDiff,
  fetchPageHistory,
  fetchPageTree,
  runReindex,
  searchPages,
  updatePage,
} from "./lib/api";

const initialBody = `# New Page\n\nWrite your documentation here.\n`;

const trimSlug = (slug: string): string => slug.replace(/^\/+|\/+$/g, "").trim();

const shortCommit = (commit: string): string => commit.slice(0, 7);

const formatDate = (value: string): string => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
};

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const App = () => {
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<"view" | "edit">("edit");
  const [isCreating, setIsCreating] = useState(false);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [statusText, setStatusText] = useState("");

  const [draftSlug, setDraftSlug] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState(initialBody);
  const [draftMetaText, setDraftMetaText] = useState("{}");
  const [commitMessage, setCommitMessage] = useState("");

  const [diffFrom, setDiffFrom] = useState("");
  const [diffTo, setDiffTo] = useState("");

  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
  });

  const treeQuery = useQuery({
    queryKey: ["page-tree"],
    queryFn: fetchPageTree,
  });

  useEffect(() => {
    if (!isCreating && activeSlug === null && treeQuery.data && treeQuery.data.length > 0) {
      const first = treeQuery.data[0];
      if (first) {
        setActiveSlug(first.slug);
      }
    }
  }, [activeSlug, isCreating, treeQuery.data]);

  const pageQuery = useQuery({
    queryKey: ["page", activeSlug],
    queryFn: () => fetchPage(activeSlug ?? ""),
    enabled: !isCreating && activeSlug !== null,
  });

  useEffect(() => {
    if (!pageQuery.data || isCreating) {
      return;
    }

    setDraftSlug(pageQuery.data.slug);
    setDraftTitle(pageQuery.data.title);
    setDraftBody(pageQuery.data.body);
    setDraftMetaText(JSON.stringify(pageQuery.data.meta ?? {}, null, 2));
    setCommitMessage("");
  }, [isCreating, pageQuery.data]);

  const historyQuery = useQuery({
    queryKey: ["history", activeSlug],
    queryFn: () => fetchPageHistory(activeSlug ?? ""),
    enabled: !isCreating && activeSlug !== null,
  });

  useEffect(() => {
    if (!historyQuery.data || historyQuery.data.length < 2) {
      return;
    }
    const latest = historyQuery.data[0];
    const previous = historyQuery.data[1];

    if (!latest || !previous) {
      return;
    }
    if (!diffTo) {
      setDiffTo(latest.commit);
    }
    if (!diffFrom) {
      setDiffFrom(previous.commit);
    }
  }, [diffFrom, diffTo, historyQuery.data]);

  const searchQuery = useQuery({
    queryKey: ["search", searchText],
    queryFn: () => searchPages(searchText),
    enabled: searchText.trim().length > 0,
  });

  const diffQuery = useQuery({
    queryKey: ["diff", activeSlug, diffFrom, diffTo],
    queryFn: () => fetchPageDiff(activeSlug ?? "", diffFrom, diffTo),
    enabled: !isCreating && activeSlug !== null && diffFrom !== "" && diffTo !== "",
  });

  const refreshCoreQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["page-tree"] }),
      queryClient.invalidateQueries({ queryKey: ["page", activeSlug] }),
      queryClient.invalidateQueries({ queryKey: ["history", activeSlug] }),
      queryClient.invalidateQueries({ queryKey: ["search"] }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: createPage,
    onSuccess: async (result) => {
      setStatusText(`Created: ${result.slug || "home"} (${shortCommit(result.commit ?? "")})`);
      setIsCreating(false);
      setActiveSlug(result.slug);
      await refreshCoreQueries();
    },
    onError: (error) => {
      setStatusText(`Create failed: ${String(error)}`);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ slug, payload }: { slug: string; payload: Parameters<typeof updatePage>[1] }) =>
      updatePage(slug, payload),
    onSuccess: async (result) => {
      setStatusText(`Saved: ${result.slug || "home"} (${shortCommit(result.commit ?? "")})`);
      await refreshCoreQueries();
    },
    onError: (error) => {
      setStatusText(`Save failed: ${String(error)}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deletePage,
    onSuccess: async (result) => {
      setStatusText(`Deleted: ${result.slug || "home"}`);
      setActiveSlug(null);
      setDraftSlug("");
      setDraftTitle("");
      setDraftBody(initialBody);
      setDraftMetaText("{}");
      setIsCreating(false);
      setDiffFrom("");
      setDiffTo("");
      await refreshCoreQueries();
    },
    onError: (error) => {
      setStatusText(`Delete failed: ${String(error)}`);
    },
  });

  const reindexMutation = useMutation({
    mutationFn: runReindex,
    onSuccess: async (result) => {
      setStatusText(`Reindex done: indexed=${result.indexed}, removed=${result.removed}`);
      await refreshCoreQueries();
    },
    onError: (error) => {
      setStatusText(`Reindex failed: ${String(error)}`);
    },
  });

  const busy =
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending ||
    reindexMutation.isPending;

  const parsedMetaResult = useMemo(() => {
    try {
      const parsed = JSON.parse(draftMetaText) as unknown;
      if (!isJsonObject(parsed)) {
        return { value: null, error: "meta must be a JSON object" };
      }
      return { value: parsed, error: "" };
    } catch (error) {
      return {
        value: null,
        error: `meta must be valid JSON: ${String(error)}`,
      };
    }
  }, [draftMetaText]);

  const healthText = useMemo(() => {
    if (healthQuery.isLoading) {
      return "API: loading";
    }
    if (healthQuery.isError || !healthQuery.data) {
      return "API: unavailable";
    }

    const git = healthQuery.data.git
      ? `${healthQuery.data.git.branch}@${healthQuery.data.git.commit}`
      : "no-git";
    return `API: ${healthQuery.data.app} ${healthQuery.data.version} (${git})`;
  }, [healthQuery.data, healthQuery.isError, healthQuery.isLoading]);

  const startCreate = () => {
    setIsCreating(true);
    setMode("edit");
    setActiveSlug(null);
    setDraftSlug("");
    setDraftTitle("");
    setDraftBody(initialBody);
    setDraftMetaText("{}");
    setCommitMessage("");
    setDiffFrom("");
    setDiffTo("");
    setStatusText("create mode");
  };

  const selectExistingPage = (slug: string) => {
    setIsCreating(false);
    setMode("view");
    setActiveSlug(slug);
    setDiffFrom("");
    setDiffTo("");
    setStatusText(`selected: ${slug || "home"}`);
  };

  const handleSave = async () => {
    const normalizedSlug = trimSlug(isCreating ? draftSlug : (activeSlug ?? ""));

    if (!draftTitle.trim()) {
      setStatusText("title is required");
      return;
    }

    if (!parsedMetaResult.value) {
      setStatusText(parsedMetaResult.error);
      return;
    }

    if (isCreating) {
      await createMutation.mutateAsync({
        slug: normalizedSlug,
        title: draftTitle.trim(),
        body: draftBody,
        meta: parsedMetaResult.value,
      });
      return;
    }

    await updateMutation.mutateAsync({
      slug: normalizedSlug,
      payload: {
        title: draftTitle.trim(),
        body: draftBody,
        meta: parsedMetaResult.value,
        commitMessage: commitMessage.trim() || undefined,
      },
    });
  };

  const handleDelete = async () => {
    if (isCreating) {
      startCreate();
      return;
    }

    if (activeSlug === null) {
      setStatusText("no page selected");
      return;
    }

    const targetSlug = trimSlug(activeSlug);
    const confirmed = window.confirm(`Delete page: ${targetSlug || "home"}?`);
    if (!confirmed) {
      return;
    }

    await deleteMutation.mutateAsync(targetSlug);
  };

  const activeLabel = isCreating ? "new" : activeSlug || "home";

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-[1800px] gap-4 px-4 py-4">
        <aside className="w-80 shrink-0 rounded-md border border-border bg-card p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h1 className="text-sm font-semibold">Wiki Pages</h1>
            <Button variant="secondary" size="sm" onClick={startCreate}>
              New
            </Button>
          </div>

          <div className="mb-3">
            <Input
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="Search title/body"
            />
            {searchQuery.isFetching ? (
              <p className="mt-1 text-xs text-muted-foreground">searching...</p>
            ) : null}
          </div>

          {searchText.trim() ? (
            <div className="mb-4 space-y-1 rounded-md border border-border p-2">
              <p className="text-xs font-medium text-muted-foreground">Search Results</p>
              {(searchQuery.data ?? []).map((item) => (
                <button
                  type="button"
                  key={`search-${item.slug}`}
                  className="w-full rounded-md px-2 py-1 text-left text-xs hover:bg-muted"
                  onClick={() => selectExistingPage(item.slug)}
                >
                  <div className="font-medium">{item.slug || "home"}</div>
                  <div className="line-clamp-2 text-muted-foreground">{item.excerpt}</div>
                </button>
              ))}
              {searchQuery.data && searchQuery.data.length === 0 ? (
                <p className="text-xs text-muted-foreground">no result</p>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-1 text-sm">
            {(treeQuery.data ?? []).map((item) => (
              <button
                type="button"
                key={item.path}
                className={`w-full truncate rounded-sm px-2 py-1 text-left hover:bg-muted ${
                  !isCreating && item.slug === activeSlug ? "bg-muted" : ""
                }`}
                onClick={() => selectExistingPage(item.slug)}
              >
                {item.slug || "home"}
              </button>
            ))}
            {treeQuery.isLoading ? <div className="px-2 text-muted-foreground">loading</div> : null}
            {treeQuery.isError ? (
              <div className="px-2 text-red-600">failed to load tree</div>
            ) : null}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col rounded-md border border-border bg-card p-3">
          <div className="mb-3 grid gap-2 md:grid-cols-2">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Slug</p>
              <Input
                value={draftSlug}
                onChange={(event) => setDraftSlug(event.target.value)}
                placeholder="engineering/onboarding"
                disabled={!isCreating}
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Title</p>
              <Input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                placeholder="Page title"
              />
            </div>
            <div className="space-y-1 md:col-span-2">
              <p className="text-xs text-muted-foreground">Meta (JSON)</p>
              <Textarea
                value={draftMetaText}
                onChange={(event) => setDraftMetaText(event.target.value)}
                className="min-h-20 font-mono text-xs"
              />
            </div>
            {!isCreating ? (
              <div className="space-y-1 md:col-span-2">
                <p className="text-xs text-muted-foreground">Commit Message (optional)</p>
                <Input
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  placeholder={`docs(page): update ${activeLabel}`}
                />
              </div>
            ) : null}
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Button
              variant={mode === "edit" ? "default" : "secondary"}
              size="sm"
              onClick={() => setMode("edit")}
            >
              Edit
            </Button>
            <Button
              variant={mode === "view" ? "default" : "secondary"}
              size="sm"
              onClick={() => setMode("view")}
            >
              View
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={busy || !!parsedMetaResult.error}
            >
              Save
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleDelete()}
              disabled={busy}
            >
              Delete
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void reindexMutation.mutateAsync()}
              disabled={busy}
            >
              Reindex
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void healthQuery.refetch();
                void treeQuery.refetch();
                if (!isCreating && activeSlug !== null) {
                  void pageQuery.refetch();
                  void historyQuery.refetch();
                }
              }}
            >
              Refresh
            </Button>
          </div>

          <div className="mb-2 text-xs text-muted-foreground">{healthText}</div>
          <div className="mb-2 text-xs text-muted-foreground">page: {activeLabel}</div>
          {parsedMetaResult.error ? (
            <div className="mb-2 text-xs text-red-600">{parsedMetaResult.error}</div>
          ) : null}
          {statusText ? (
            <div className="mb-2 text-xs text-muted-foreground">{statusText}</div>
          ) : null}
          {pageQuery.isLoading && !isCreating ? (
            <div className="mb-2 text-xs text-muted-foreground">loading page...</div>
          ) : null}

          <div className="h-[calc(100vh-23rem)] min-h-[360px] overflow-hidden rounded-md border border-border">
            <MarkdownEditor
              value={draftBody}
              onChange={setDraftBody}
              editable={mode === "edit"}
              toolbarMode={mode === "edit" ? "fixed" : "hidden"}
              className="h-full"
              enableVerticalScroll
              enableMermaid
            />
          </div>
        </section>

        <aside className="w-96 shrink-0 rounded-md border border-border bg-card p-3">
          <h2 className="mb-2 text-sm font-semibold">History & Diff</h2>

          <div className="mb-3 max-h-60 space-y-1 overflow-auto rounded-md border border-border p-2">
            {(historyQuery.data ?? []).map((item) => (
              <button
                type="button"
                key={item.commit}
                className="w-full rounded-md px-2 py-1 text-left text-xs hover:bg-muted"
                onClick={() => setDiffTo(item.commit)}
              >
                <div className="font-mono">{item.commit.slice(0, 8)}</div>
                <div className="text-muted-foreground">{item.message}</div>
                <div className="text-muted-foreground">{item.author}</div>
                <div className="text-muted-foreground">{formatDate(item.date)}</div>
              </button>
            ))}
            {historyQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">loading history...</p>
            ) : null}
            {!historyQuery.isLoading && (historyQuery.data?.length ?? 0) === 0 ? (
              <p className="text-xs text-muted-foreground">no history</p>
            ) : null}
          </div>

          <div className="mb-2 space-y-1">
            <p className="text-xs text-muted-foreground">From commit</p>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={diffFrom}
              onChange={(event) => setDiffFrom(event.target.value)}
            >
              <option value="">Select commit</option>
              {(historyQuery.data ?? []).map((item) => (
                <option key={`from-${item.commit}`} value={item.commit}>
                  {shortCommit(item.commit)} {item.message}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-3 space-y-1">
            <p className="text-xs text-muted-foreground">To commit</p>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={diffTo}
              onChange={(event) => setDiffTo(event.target.value)}
            >
              <option value="">Select commit</option>
              {(historyQuery.data ?? []).map((item) => (
                <option key={`to-${item.commit}`} value={item.commit}>
                  {shortCommit(item.commit)} {item.message}
                </option>
              ))}
            </select>
          </div>

          <div className="h-[calc(100vh-30rem)] min-h-[220px] overflow-auto rounded-md border border-border bg-muted/30 p-2">
            <pre className="whitespace-pre-wrap break-words text-xs leading-5">
              {diffQuery.data && diffQuery.data.length > 0
                ? diffQuery.data
                : "Select two commits to view diff."}
            </pre>
          </div>
        </aside>
      </div>
    </main>
  );
};

export default App;
