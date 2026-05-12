# Git-Backed Local Wiki 実装計画（Hono + TypeScript）

## 1. 目的と前提

- 目的: Git + Markdown を正とするローカル Wiki を構築する。
- 実行環境: 完全ローカル（LAN公開は任意）。
- v1 スコープ:
  - 認証/ログイン/RBAC は実装しない。
  - 編集・閲覧・検索・履歴確認を最優先。
  - ナレッジ共有は「別 Git リポジトリ（コンテンツ専用）」で行う。
- 将来拡張: Embedding + Gemma4 等による実装向け知識蒸留パイプラインを追加。

## 2. 参照OSSからの取り込み方

### Raneto から借りる（実装の骨格）

- `content/pages` 配下の Markdown をコンテンツとして扱う思想。
- URL slug とファイルパスの対応。
- Web編集（ページ作成/更新/削除）APIの流れ。
- メタデータ（Frontmatter）とメニュー構築。
- 検索対象を「ファイル名 + 本文」にする設計。

参照箇所:
- [Raneto README](/Users/y.noguchi/Code/Raneto/README.md)
- [Raneto app index](/Users/y.noguchi/Code/Raneto/app/index.js)
- [Raneto contents handler](/Users/y.noguchi/Code/Raneto/app/core/contents.js)
- [Raneto page handler](/Users/y.noguchi/Code/Raneto/app/core/page.js)
- [Raneto search handler](/Users/y.noguchi/Code/Raneto/app/core/search.js)
- [Raneto wildcard route](/Users/y.noguchi/Code/Raneto/app/routes/wildcard.route.js)

### markdownWysiwyg から借りる（編集・表示体験）

- `MarkdownEditor` を編集UIとして利用。
- `editable=false` で read-only viewer としても利用可能。
- 必要なら `StaticHtmlGenerator` で HTML 生成（クライアント側主体）。
- Mermaid/画像/テーブル等の編集機能を活用。

参照箇所:
- [markdownWysiwyg README](/Users/y.noguchi/Code/markdownWysiwyg/README.md)
- [markdownWysiwyg exports](/Users/y.noguchi/Code/markdownWysiwyg/src/index.ts)
- [StaticHtmlGenerator](/Users/y.noguchi/Code/markdownWysiwyg/src/converters/StaticHtmlGenerator.ts)

## 3. リポジトリ構成（アプリとナレッジを分離）

`/Users/y.noguchi/Code/wiki`（アプリ本体）

```txt
wiki/
  apps/
    api/                # Hono API
    web/                # React + Vite
  packages/
    shared/             # API型, Zod schema, 共通ユーティリティ
    content-git/        # Git/FS操作ドメイン
    markdown/           # frontmatter, wikilink, slug解決
  drizzle/
    migrations/
  docs/
  package.json
  pnpm-workspace.yaml
```

`/Users/y.noguchi/Code/wiki/wiki-knowledge`（アプリ配下だが別Git、コンテンツ専用）

```txt
wiki-knowledge/
  pages/
    index.md
    engineering/
      onboarding.md
  assets/
    images/
  .wiki/
    config.yaml
```

ポイント:
- アプリRepoとコンテンツRepoを分離し、チーム共有は `wiki-knowledge` を pull/push する。
- アプリRepo側の `.gitignore` で `wiki-knowledge/` を除外し、親Gitにはコンテンツを載せない。
- デフォルトは `CONTENT_ROOT=wiki-knowledge` とし、相対パスはアプリRepoルート基準で解決する。
- `.env` / `.env.local` で `CONTENT_ROOT`, `DATA_DIR`, `DATABASE_PATH` を上書きできる。外部コンテンツRepoを使う場合は絶対パスも指定可能。

## 4. 技術スタック

- Backend: Hono + TypeScript + Node.js
- Frontend: React + Vite + TanStack Query
- UI: Tailwind CSS v4 + shadcn/ui base components
- DB: SQLite + Drizzle ORM + `better-sqlite3`
- Test: Vitest（unit/integration）+ API contract tests
- Lint/Format: Biome
- Git操作: simple-git（または child_process 経由の git コマンド）
- Markdown編集/表示: `markdown-wysiwyg-editor`

## 5. v1 機能要件（MVP）

### ページ

- 一覧（ツリー）取得
- ページ取得（slug指定）
- ページ作成
- ページ更新
- ページ削除（実装は `git rm` か `*.del` 選択可能）

### 履歴

- ページ単位の履歴一覧（`git log -- <file>`）
- 任意2リビジョンの差分（`git diff <a> <b> -- <file>`）

### 検索

- タイトル + 本文の全文検索
- v1は SQLite FTS5 ベース
- インデックス再構築API/CLIを提供

### ナビゲーション

- ディレクトリベースのサイドバー
- `index.md` をセクショントップとして扱う
- Frontmatterでソート/表示制御

## 6. データモデル（Drizzle + SQLite）

`pages`:
- `id` TEXT PK（slug）
- `slug` TEXT UNIQUE
- `title` TEXT
- `path` TEXT UNIQUE
- `content_hash` TEXT
- `updated_at` INTEGER
- `last_commit` TEXT

`page_meta`:
- `slug` TEXT PK/FK
- `show_on_menu` INTEGER
- `show_on_home` INTEGER
- `sort` INTEGER
- `tags` TEXT(JSON)

`page_links`:
- `from_slug` TEXT
- `to_slug` TEXT
- UNIQUE(`from_slug`,`to_slug`)

`search_fts`:
- FTS5 virtual table (`slug`, `title`, `body`)
- Drizzle schemaだけに閉じず、FTS5はraw SQL migrationで作成する。

`ingestion_jobs`（将来）:
- `id`, `job_type`, `target_slug`, `status`, `error`, `created_at`, `updated_at`

## 7. API設計（Hono）

`GET /api/health`
- 稼働確認、contentRoot と git 状態要約を返す

`GET /api/pages/tree`
- ディレクトリ/ページのツリー取得

`GET /api/pages/*`
- Markdown本文 + frontmatter + git最終更新情報を返す
- `engineering/onboarding` のような複数階層slugは、`new URL(c.req.url).pathname` から `/api/pages/` prefix を剥がして取得する

`POST /api/pages`
- 入力: `slug`, `title`, `body`, `meta`
- 動作: ファイル作成 -> git add -> git commit

`PUT /api/pages/*`
- 入力: `body`, `meta`, `commitMessage?`
- 動作: 保存 -> git add -> git commit -> インデックス更新

`DELETE /api/pages/*`
- 動作: git rm（または論理削除）-> commit -> インデックス更新

`GET /api/search?q=...`
- FTS検索結果を返す（抜粋付き）

`GET /api/history/*`
- commit一覧（hash, author, date, message）

`GET /api/diff/*`
- query: `from=<sha>&to=<sha>`
- unified diff を返す

`POST /api/reindex`
- 全文再索引

ルーティング注意:
- `/api/pages/tree` のような固定ルートは `/api/pages/*` より先に登録する。
- Honoのwildcardはマッチング用途に使い、slug抽出はprefix stripで実装する。

## 8. コンテンツとGit操作ルール

- slug -> path:
  - `engineering/onboarding` -> `pages/engineering/onboarding.md`
  - `engineering` のトップは `pages/engineering/index.md`
- path traversal 防止を必須（Ranetoの `getFilepath` 相当をTSで実装）。
- API pathから取り出したslugはURL decode後に正規化し、`pages/` 配下に収まることを必ず検証する。
- commit message 規約:
  - `docs(page): create engineering/onboarding`
  - `docs(page): update engineering/onboarding`
  - `docs(page): delete engineering/onboarding`
- author はローカル git config を利用。

## 9. Frontend設計（React + TanStack Query）

画面構成:
- 左: ページツリー + 検索
- 中央: Viewer/Editor 切替
- 右（任意）: 履歴・差分・backlinks

UI方針:
- Tailwind CSS v4 を前提にする。
- shadcn/ui の base components とデザイントークンを標準UI層として使う。
- 独自UIは必要最小限にし、ボタン/入力/タブ/ダイアログ/ドロップダウン/トースト等は shadcn/ui の部品を優先する。
- `markdown-wysiwyg-editor` は shadcn/ui 互換トークンに合わせて読み込む。

主要コンポーネント:
- `PageTreePanel`
- `SearchPanel`
- `PageViewer`（`MarkdownEditor editable={false}`）
- `PageEditor`（`MarkdownEditor editable={true}`）
- `HistoryPanel`
- `DiffPanel`

TanStack Query:
- `usePageTreeQuery`
- `usePageQuery(slug)`
- `useSearchQuery(query)`
- `usePageHistoryQuery(slug)`
- `useSavePageMutation`
- `useDeletePageMutation`

## 10. markdownWysiwyg 統合方針

- 依存: `markdown-wysiwyg-editor`
- CSS: Tailwind v4 + shadcn/ui token base に統合する。
  - 第一候補: `markdown-wysiwyg-editor/dist/bundle.css`
  - Vite/CSS解決で問題があれば `markdown-wysiwyg-editor/theme` + `markdown-wysiwyg-editor/style` に切り替える。
- Viewer:
  - 初期は `MarkdownEditor editable={false}` を採用。
  - 表示専用軽量化が必要になれば `StaticHtmlGenerator` + 専用表示に分離。
- 画像:
  - `onImageSourceSelect` で `${CONTENT_ROOT}/assets/images` へ保存するAPIに接続。
- Mermaid:
  - `enableMermaid=true` をオプション化。

## 11. 将来拡張（Embedding / Gemma4 / 蒸留）

### フェーズ2（検索高度化）

- チャンク分割（見出し単位 + トークン上限）
- `chunks` テーブル追加
- 埋め込みベクトル保存（SQLite拡張 or 外部ベクトルDB差替可能なIF）
- hybrid検索（FTS + ベクトル）

### フェーズ3（実装向け知識蒸留）

- 対象: 「実装で再利用しやすい知識」に限定
  - API仕様
  - 運用手順
  - 既知の落とし穴
  - サンプルコード断片
- ジョブ:
  - `distill:changed-pages`（Git差分起点）
  - `distill:all`（全再構築）
- LLM実行基盤:
  - まずは Gemma4 ローカル呼び出し
  - 将来 OpenAI 等へ差替可能な `LlmProvider` 抽象を持つ

`knowledge_distillates`（将来）:
- `id`, `source_slug`, `kind`, `summary_md`, `code_snippets_json`, `updated_at`, `model`

## 12. 実装フェーズ計画

### Phase 0: ブートストラップ（0.5〜1日）

- monorepo初期化（api/web/shared）
- Hono + Vite + Vitest + Drizzle + SQLite 接続
- Tailwind CSS v4 + shadcn/ui base components 初期化
- `markdown-wysiwyg-editor` のCSS読み込み確認
- Biome 初期化（format/lint/check scripts）
- `wiki-knowledge` 作成、`git init`、初期 `pages/index.md`、`.wiki/config.yaml`、初回commit
- `.env.example` に `CONTENT_ROOT=wiki-knowledge` を明示し、必要に応じて `.env.local` で上書き

完了条件:
- `pnpm dev` で Web を `apps/api/public` に出力し、API 1ポートで起動
- `GET /api/health` が成功
- shadcn/ui の基本コンポーネントと `MarkdownEditor` が同一テーマで表示される
- `pnpm check` で Biome と Vitest の最小検証が通る

### Phase 1: ページCRUD + Git連携（2〜3日）

- slug/path解決・frontmatter処理
- 作成/更新/削除 API
- git add/commit 連携

完了条件:
- UIから作成/編集/削除でき、`wiki-knowledge` に反映される
- commit が生成される

### Phase 2: ツリー・検索・履歴（2〜3日）

- ツリー生成
- SQLite FTS インデックス
- 履歴/差分 API と UI

完了条件:
- 検索結果からページ遷移可能
- 履歴一覧と差分が確認可能

### Phase 3: 品質強化（1〜2日）

- テスト追加
- エラーハンドリング/競合保存時の挙動
- CLI（`wiki reindex`）追加

完了条件:
- `vitest` 安定通過
- 主要APIの異常系テスト完了

## 13. テスト戦略（Vitest）

- Unit:
  - slug/path正規化
  - frontmatter parse/serialize
  - wikilink/backlink 抽出
- Integration:
  - API CRUD（ローカル一時Git repo使用）
  - reindex/search
  - history/diff
- E2E相当（任意）:
  - React画面で「編集 -> 保存 -> 検索ヒット」を確認

## 14. リスクと対策

- Git競合:
  - 保存時に `HEAD` との差分確認、競合時は 409 を返す。
- 大規模化で遅延:
  - v1は同期処理、v1.1で watcher + incremental index。
- markdownWysiwyg の依存条件:
  - React 19 / Tailwind v4 / shadcn/ui tokens を固定し、host側CSS設定を最初に確定。
- DB破損/再構築:
  - `reindex` を常備し、SQLiteはキャッシュ扱いにする（正はGit）。

## 15. 最初の実装タスク（着手順）

1. `apps/api` に Hono の `health/pages` ルートを作成  
2. `packages/content-git` に `resolveSlugPath`, `readPage`, `writePage`, `commitChanges` を実装  
3. `apps/web` に `PageTree + Viewer + Editor` の最小画面を作成  
4. `markdown-wysiwyg-editor` を組み込み（編集/閲覧モード切替）  
5. Drizzle で `pages/search_fts` を作成し `reindex/search` APIを接続  
6. 履歴/差分APIを追加して v1完了

## 16. 開発コマンド方針

```txt
pnpm dev       # WebをpublicへbuildしてAPI 1ポートで起動
pnpm build     # Web public出力 + API build
pnpm start     # build後、API 1ポートで起動
pnpm verify    # format/lint/typecheck/unit/build/smoke を一括実行
pnpm test      # Vitest
pnpm lint      # Biome lint
pnpm format    # Biome format
pnpm check     # Biome check + Vitest
pnpm db:push   # Drizzle schema反映（ローカル）
pnpm reindex   # SQLite/FTS再構築
```
