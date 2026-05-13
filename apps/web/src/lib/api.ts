import type {
  FolderMutationResponse,
  HealthResponse,
  PageDocument,
  PageHistoryItem,
  PageMutationResponse,
  PageTreeResponse,
  ReindexResponse,
  SearchResultItem,
} from "@wiki/shared";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";

const buildUrl = (path: string) => `${apiBase}${path}`;

const encodeSlug = (slug: string): string =>
  slug
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

const getJson = async <T>(path: string): Promise<T> => {
  const res = await fetch(buildUrl(path));
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Request failed: ${res.status} ${errorText}`);
  }
  return (await res.json()) as T;
};

const sendJson = async <T>(path: string, method: "POST" | "PUT" | "DELETE", body?: unknown) => {
  const res = await fetch(buildUrl(path), {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Wiki-Request": "local",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Request failed: ${res.status} ${errorText}`);
  }

  return (await res.json()) as T;
};

export const fetchHealth = () => getJson<HealthResponse>("/api/health");

export const fetchPageTree = async (): Promise<PageTreeResponse> => getJson("/api/pages/tree");

export const fetchPage = (slug: string) => getJson<PageDocument>(`/api/pages/${encodeSlug(slug)}`);

export const createPage = (payload: {
  slug: string;
  title: string;
  body: string;
  meta?: Record<string, unknown>;
}) => sendJson<PageMutationResponse>("/api/pages", "POST", payload);

export const updatePage = (
  slug: string,
  payload: {
    slug?: string;
    title?: string;
    body: string;
    meta?: Record<string, unknown>;
    commitMessage?: string;
  },
) => sendJson<PageMutationResponse>(`/api/pages/${encodeSlug(slug)}`, "PUT", payload);

export const deletePage = (slug: string) =>
  sendJson<PageMutationResponse>(`/api/pages/${encodeSlug(slug)}`, "DELETE");

export const createFolder = (payload: { path: string }) =>
  sendJson<FolderMutationResponse>("/api/folders", "POST", payload);

export const renameFolder = (path: string, payload: { path: string }) =>
  sendJson<FolderMutationResponse>(`/api/folders/${encodeSlug(path)}`, "PUT", payload);

export const deleteFolder = (path: string) =>
  sendJson<FolderMutationResponse>(`/api/folders/${encodeSlug(path)}`, "DELETE");

export const searchPages = async (query: string): Promise<SearchResultItem[]> => {
  const encoded = encodeURIComponent(query.trim());
  const data = await getJson<{ items: SearchResultItem[] }>(`/api/search?q=${encoded}`);
  return data.items;
};

export const fetchPageHistory = async (slug: string): Promise<PageHistoryItem[]> => {
  const data = await getJson<{ slug: string; items: PageHistoryItem[] }>(
    `/api/history/${encodeSlug(slug)}`,
  );
  return data.items;
};

export const fetchPageDiff = async (slug: string, from: string, to: string): Promise<string> => {
  const data = await getJson<{ diff: string }>(
    `/api/diff/${encodeSlug(slug)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  return data.diff;
};

export const runReindex = () => sendJson<ReindexResponse>("/api/reindex", "POST");
