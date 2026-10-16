# CodeRefiner

**「機械的には動くが、人間には読みにくいコード」を、「人間が理解・保守・再利用しやすいコード」へ安全に整理するツール。**

ノーコードの編集画面はありません。ZIP またはフォルダを入力すると、プロジェクト全体を解析し、別の ZIP / フォルダとして出力します。
主な対象は AI が生成した HTML / CSS / JavaScript / TypeScript プロジェクトです。

- AI にコードを丸ごと書き直させません。コード自身から意味を復元し、**パーサ → AST → 意味解析 → ルール → 再出力 → 検証** の順で変換します。
- **AI API なしで主要機能がすべて動きます。** AI Advisor は完全にオプションで、最終決定権を持ちません。
- **分からないものは変更しません。** 確信度が低い候補はレポートに載せるだけです。
- **元のプロジェクトは決して上書きしません。** `original/` と `refined/` を分けて出力します。

```
Project → Scanner → Language Detection → Parser → AST/CST → Semantic Analysis
        → Rule Engine → Refactoring / Naming → Code Printer → Formatter
        → Validation (+ Rollback) → Refined Project + Report
```

## Web 版 (GitHub Pages)

ブラウザだけで動く静的サイト版があります。**コードはサーバーに送信されず、すべてお使いのブラウザ内 (Web Worker) で処理されます。**
ZIP またはフォルダをドロップ → Mode を選択 → REFINE → レポート表示 / ZIP 書き出し / (対応ブラウザでは) フォルダへ保存。
AI Advisor を使う場合のみ、プロバイダ (Anthropic / OpenAI / Google Gemini / ローカル LLM) を選んで自分の API キーを入力します (メモリ上にだけ保持。変数名と小さなコード断片だけをプロバイダに送ります)。UI は日本語 / English を切り替えられます (ブラウザの言語で自動選択)。

```bash
npm run build:web      # ./site に静的サイトを生成
npm run serve:web      # http://127.0.0.1:4174/ でプレビュー
```

**GitHub Pages へのデプロイ**: `.github/workflows/pages.yml` が `main` / `master` への push (または手動実行) で、型チェック → テスト → `build:web` → デプロイまで行います。初回だけリポジトリの **Settings → Pages → Build and deployment → Source を「GitHub Actions」** に設定してください。公開 URL は `https://<owner>.github.io/<repo>/` です (すべて相対パスなのでサブパス配下でも動きます)。
別ブランチで試す場合は Actions タブから "Deploy web version to GitHub Pages" を手動実行します (環境の保護ルールでブランチが許可されている必要があります)。
GitHub Pages を使えない場合は、同じ `site/` をそのまま Netlify (`netlify.toml`) / Vercel (`vercel.json`) / Cloudflare Pages (ビルドコマンド `npm run build:web`、出力 `site`) などの静的ホスティングに置けます。

ブラウザ版の制限: ネイティブ整形ツール (gofmt / rustfmt / ruff / clang-format …) と TypeScript 型チェック、build/test 実行は CLI 版のみです (対応言語は解析・構文チェックのみ行い、整形はしません)。

## クイックスタート

```bash
npm install
npm run build

# CLI
node dist/cli.js ./my-project            # フォルダ入力  → ./my-project-refined/
node dist/cli.js ./app.zip --mode cautious
node dist/cli.js ./app.zip -o ./out --remove-unused

# 画面 (ZIP / フォルダをドロップして REFINE)
node dist/cli.js ui                       # http://127.0.0.1:4173/
```

出力ディレクトリ:

```
<out>/
├── original/             入力そのまま (比較・ロールバック用)
├── refined/              整理後のプロジェクト
├── refined-project.zip   refined/ の ZIP
├── report.html           自己完結型レポート (外部通信なし)
├── report.json           同内容の機械可読版 (意味モデル・call graph・data flow 含む)
└── changes.diff          unified diff
```

コマンド一覧: `code-refiner <入力> [options]` / `ui` / `rules` (ルール一覧) / `init-config`。

| オプション | 内容 |
|---|---|
| `-m, --mode safe\|cautious\|aggressive` | リファクタリングレベル (既定: `safe`) |
| `-c, --config <file>` | JSON 設定ファイル (`coderefiner.config.example.json` 参照) |
| `--ai` | AI Advisor を有効化 (キーが無ければ警告のうえローカル解析のみで続行) |
| `--ai-provider anthropic\|openai\|gemini\|local` | AI の提供元。キーは `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` (または `GOOGLE_API_KEY`) から読みます。`local` は OpenAI 互換サーバ (Ollama / LM Studio / llama.cpp / vLLM) でキー不要 |
| `--ai-model <name>` | モデル名 (既定: `claude-haiku-5-5` / `gpt-4o-mini` / `gemini-2.0-flash` / `llama3.2`) |
| `--ai-base-url <url>` | API の URL (local の既定: `http://localhost:11434/v1`) |
| `--lang en\|ja` | レポートとメッセージの言語 (既定: 環境の `LANG` から自動) |
| `--no-rename` | 変数のリネームをしない |
| `--remove-unused` | 未使用 import / 到達不能コード / 副作用のない未使用ローカルを削除 (cautious 以上) |
| `--no-validate` | 検証を無効化 (非推奨) |
| `--run-commands` | プロジェクトの build / test スクリプトも実行して検証 (**プロジェクトのコードを実行します**) |

## 対応言語

| 言語 | 構文チェック / 語彙 / 関数メトリクス / 重複検出 | 整形 | 意味解析・リネーム・リファクタリング |
|---|---|---|---|
| JavaScript / TypeScript (JSX/TSX 含む) | Babel | Prettier (同値性を AST で証明) | ✅ |
| HTML / CSS / JSON | parse5 / postcss / JSON.parse | Prettier (同値性を検証) | HTML-CSS-JS 横断解析、限定的な安全ルール |
| SCSS / Less / Markdown / YAML / Vue / GraphQL | Prettier の構文解析 | Prettier (再整形が不変であることを確認) | – |
| Java / C# / C / C++ | tree-sitter | clang-format または google-java-format があれば (**トークン列が不変であることを証明できた場合のみ**採用) | – |
| Go / Rust | tree-sitter | gofmt / rustfmt があれば | – |
| Python | tree-sitter | ruff / black があれば (**AST が同一であることを `ast.dump` で確認**) | – |
| Ruby / PHP / Kotlin / Swift / Shell / Scala | tree-sitter | (Shell は shfmt があれば) | – |

tree-sitter 系の言語は WebAssembly パーサで構文を検証します。構文エラーのあるファイルは**無変更のままコピー**し警告を出します。
関数単位の行数・ネスト・引数・分岐数 (Complexity)、構造が同一の関数 (Duplicate)、プロジェクト語彙 (Vocabulary) は全言語で解析されます。
ネイティブ整形ツールは**インストールされている場合のみ**使われ、無ければ解析のみで整形はスキップされます。整形結果は必ず検証ゲートを通り、証明できなければ元のままにします。
意味解析・リファクタリングルールを持つのは現状 JS / TS のみです (他言語は Language Pack の `refine()` にルールを追加して拡張できます)。

## リファクタリングレベル

| レベル | 意味 | 例 |
|---|---|---|
| **SAFE** (既定) | 意味変更の可能性が極めて低いもの | 再代入されない `let` → `const`、真偽値が明らかな `if/else return true/false` の簡略化、`!!` の除去 (条件式内)、`else { if }` → `else if`、直後に return されるだけの一時変数のインライン化、重複 import の統合、重複宣言の削除 (CSS)、冗長な `type="text/javascript"` の削除、確信度 95% 以上のリネーム |
| **CAUTIOUS** | 意味的な推測を伴うもの | `Boolean(x)` を使った return 簡略化、else-after-return、`var` → `const/let` (スコープが変わらない場合のみ)、文字列連結 → テンプレートリテラル (確実に文字列連結のものだけ)、import 並べ替え、空の CSS ルール削除、確信度 80% 以上のリネーム、(`--remove-unused` で) 未使用 import / 到達不能コードの削除 |
| **AGGRESSIVE** | 構造変更を伴うもの | インデックス `for` ループ → `for…of` (要素名をコレクション名から決定。添字の他用途・配列の変更・クロージャ捕捉があれば変換しない)、他から参照されないクラシックスクリプトのグローバル変数・関数の `const` 化とリネーム、`function(){}` コールバック → アロー関数 (`this` / `arguments` 不使用時)、(`--remove-unused` で) 副作用のない未使用ローカル・関数の削除 |

`code-refiner rules` で全ルールを確認できます。

## 命名エンジンと確信度

`const x = stations.filter(s => s.active)` のような名前を、決め打ちではなく**候補生成 → スコアリング → 確信度判定**で扱います。

1. **Candidate Generation** — 代入元・メソッド・プロパティ・型・使用先 (`push` / クリック / 累積)・全呼び出し元の引数名・ファイル名・周辺関数名・Project Vocabulary・Project Naming Convention から複数候補を作ります (`activeStations` / `filteredStations` / `availableStations` …)。
2. **Scoring** — 根拠ごとに加点 (`sourceMatch +30`, `methodMatch +20`, `propertyMatch +20`, `usageMatch +15`, `typeMatch +10`, `conventionMatch +10` …)、曖昧な名前・衝突・文脈不一致は減点。**重みは設定で変更できます** (`namingWeights`)。
3. **Confidence** — 既定の閾値は `95%以上: 自動適用可` / `80〜95%: 推奨` / `50〜80%: 候補表示` / `50%未満: 変更しない` (`thresholds` で変更可)。適用に必要な閾値は SAFE が 95%、CAUTIOUS / AGGRESSIVE が 80% です (`renameApplyThreshold` で上書き可)。
4. **Project Vocabulary** — プロジェクト全体の頻出語・表記揺れ (`station / stations / stationData / stn`)・略語 (`stn → station`) を収集し、レポートに出力します。
5. **Naming Convention Detection** — 既存コードから `Collection → xxxList` か `plural noun` か、camelCase / snake_case、真偽値の `is/has` 接頭辞を推測し、新しい名前の生成に反映します。

名前の根拠になる情報は、データの流れ (`stations.filter(s => s.active)` → `activeStations`)、`for…of` / コールバックの要素 (`station`)、DOM の id (`getElementById('todo-list')` → `todoList`、`.value` → `todoInputValue`)、`innerHTML` に流れ込む文字列 (`html`)、イベント配線 (`addEventListener('click', f1)` → `handleAddButtonClick`)、`innerHTML` を書き換える関数 (`renderTodoList`)、手書きの絞り込みループ (`if (todo.done) res.push(todo)` → `doneTodos`)、`addTodo()` が作って返すオブジェクト (`todo`)、全呼び出し元が渡す引数名、`cnt → count` のような略語展開、プロジェクト固有の略語です。関数名・変数名・引数名が対象で、1 回目のリネーム結果を 2 回目の解析が使います (`x` → `activeStations` → ループ変数 `activeStation`)。

リネームは必ず**スコープ解析で局所的と証明できる場合だけ**行います。次は変更しません: export されている名前、HTML のインラインハンドラが参照する名前、`eval` / `with` を含むファイル、既存名・ネストしたスコープ・グローバル参照との衝突。
クラシックスクリプトのトップレベル名 (グローバル) は他のファイルや HTML から参照され得るため、**SAFE / CAUTIOUS では変更しません**。AGGRESSIVE (または設定 `renameGlobals: "unreferenced"`) では、**他のどのファイル・インラインハンドラ・`window.x` / `window[...]` からも参照されていないと確認できたものだけ**を対象にします (単体の JS ファイルを読み込んだときはこの判定で対象になります。外部から使われるライブラリの場合は `renameGlobals: "never"` にしてください)。

### AI Advisor (オプション)

ローカル解析で決め切れない名前 (確信度が `autoApply` 未満で、SAFE 以外のモード) についてだけ、必要最小限の文脈 (宣言・数箇所の使用例・候補名・プロジェクト語彙と命名規則・囲む関数名) を AI に尋ねます。ファイル全体は送りません。

| プロバイダ | 設定 | キー |
|---|---|---|
| Anthropic (Claude) | `ai.provider: "anthropic"` | `ANTHROPIC_API_KEY` |
| OpenAI | `"openai"` | `OPENAI_API_KEY` |
| Google Gemini | `"gemini"` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| **ローカル LLM** | `"local"` (OpenAI 互換: Ollama, LM Studio, llama.cpp server, vLLM …) | 不要 (`LOCAL_LLM_API_KEY` で任意指定) |

```bash
# OpenAI
OPENAI_API_KEY=sk-... code-refiner ./app --mode cautious --ai-provider openai
# Gemini
GEMINI_API_KEY=... code-refiner ./app --mode cautious --ai-provider gemini --ai-model gemini-2.0-flash
# Ollama (キー不要)
ollama pull qwen2.5-coder && code-refiner ./app --mode cautious --ai-provider local --ai-model qwen2.5-coder
# LM Studio
code-refiner ./app --ai-provider local --ai-base-url http://localhost:1234/v1 --ai-model <model>
```

Web 版からローカル LLM を使う場合は、ブラウザが直接アクセスするため**サーバ側で CORS を許可**してください (Ollama: `OLLAMA_ORIGINS=*`)。

AI にできること: ①ローカル候補から選ぶ (+5 点)、②「どれも違う」と拒否する (推奨未満に制限)、③**新しい名前を 1 つ提案する**。提案は有効な識別子であること・衝突しないこと・曖昧語でないことを確認したうえで**確信度 82% 上限の候補**として扱うため、SAFE モードでは適用されず、CAUTIOUS / AGGRESSIVE でもローカルの根拠付き候補が優先されます。AI が失敗・タイムアウトしても処理は止まりません。

## 日本語対応

- **UI・レポート・メッセージ**: Web 版 / ローカル UI は日本語 / English を切り替え可能 (ブラウザの言語で自動選択)。CLI は `--lang ja` (または `LANG=ja_JP.UTF-8`) で出力とレポートが日本語になります。`report.json` の内容は英語のままです。
- **文字コード**: UTF-8 に加え **Shift_JIS (CP932) / EUC-JP / UTF-16** のファイルをそのまま扱い、**元の文字コードで書き戻します**。デコード→エンコードで元のバイト列が完全に復元できる場合だけ受け入れ、判定できないファイルは**変更せずコピー**します (文字化けさせません)。
- **日本語の識別子・コメント・文字列**: そのまま保持します。日本語の識別子もリネーム候補の根拠 (`駅一覧.filter(...)` → `active駅一覧List` のように、複数形のない語には `List` を付けます) にでき、新しい名前は常に有効な識別子であることを確認します。
- **AI の理由説明**は UI の言語に合わせて日本語で返します。

## 安全性の仕組み## 安全性の仕組み

- 各変換は **Parse → Transform → Parse again** で検証し、失敗した変換だけを巻き戻します (高速パスで失敗したら 1 ルールずつの隔離実行に切り替えます)。
- 書式のみの変更は **AST 同値性** (引用符・括弧・プロパティキー表記を正規化) で、意味が変わっていないことを証明します。証明できなければ整形しません。
- 最終ゲート (`validation`): 構文再チェック → **公開面 (export / グローバル名) の不変確認** → 書式変更の同値確認 → **TypeScript 型チェックの比較** (元の診断より増えたファイルのみロールバック)。いずれも「却下」しかできず、変更を作り出すことはありません。
- 任意で `--run-commands`: 元と整理後の両方で build / test を実行し、**元では成功するのに整理後に失敗した場合は全変更を元に戻します**。元で既に失敗するコマンドは判定不能としてスキップします。
- 読めないファイル・未対応言語・バイナリ・無視対象は**バイト単位でそのままコピー**します。BOM・改行コード (CRLF/LF) も保持します。
- 既定で除外: `node_modules`, `.git`, `target`, `venv`, `__pycache__` … は出力にも含めません (`omit`)。`dist`, `build`, `*.min.js`, ロックファイル … は解析も変更もせずコピーします (`ignore`)。`include` で再有効化できます。

## 解析機能

- **Project Metadata**: runtime / languages / frameworks / entryPoints / build ツール / テストランナー / 検証コマンドを `package.json`・`vite.config.*`・`tsconfig.json`・`Cargo.toml` などから推定。
- **Semantic Model** (JS/TS): 変数 (宣言・種別・型推定・初期化式・参照・代入回数・スコープ・export)、関数 (引数・戻り値・呼び出し元/先・循環的複雑度)、モジュール (import/export・解決済み依存)、Data Flow (`source → transform → result → consumer`)、Call Graph (ファイルをまたぐ呼び出しも解決)。
- **HTML / CSS / JS 横断解析**: `id`・`class`・`data-*`・`getElementById` / `querySelector` / `classList` / `dataset` / `addEventListener` / `on*` 属性 / インライン `<script>` `<style>` を関連付け、未使用 CSS セレクタ・存在しない要素 ID・未定義のインラインハンドラ・重複 ID を報告。
- **Dead Code**: 未使用の変数 / 関数 / import / CSS / `@keyframes` / カスタムプロパティ、到達不能コード、未参照ファイル (**既定では削除せず報告のみ**)。
- **Duplicate**: 構造が同一の関数 (識別子・リテラルを無視)、同一宣言ブロックの CSS ルール、コピペ block。
- **Complexity**: 巨大関数・深いネスト・多すぎる引数・分岐過多・循環依存 (しきい値は `complexity` で変更可)。

## 設定

```json
{
  "mode": "safe",
  "renameVariables": true,
  "removeUnused": false,
  "refactorDuplicates": false,
  "aiAdvisor": false,
  "validation": true
}
```

`refactorDuplicates` は現状**検出・報告のみ**です (自動統合はしません)。`ai` (`provider` / `model` / `baseUrl`)、`language` (`auto` / `en` / `ja`)、`renameGlobals` (`auto` / `never` / `unreferenced`) も指定できます。そのほかのキー (`thresholds`, `namingWeights`, `complexity`, `ignore`, `omit`, `include`, `validationOptions`, `ai`, `languagePacks` …) は `coderefiner.config.example.json` を参照してください。

## アーキテクチャ

```
src/
├── core/            Project Scanner / ZIP / Language Detection / Metadata / Config / Rule Engine / Diff Engine
├── semantic/        言語非依存の Semantic Model と Project Model (dependency / call graph / data flow)
├── naming/          Vocabulary / Convention / Candidate Generation / Scoring / Confidence
├── analysis/        Dead Code / Duplicate / Complexity / HTML-CSS-JS Cross Reference
├── validation/      構文・公開面・同値性・型チェック・build/test + Rollback
├── ai/              AI Advisor (Anthropic / OpenAI / Gemini / ローカル LLM。オプション)
├── i18n/            日本語 / English (メッセージ翻訳・言語判定)
├── report/          HTML レポート
├── languages/       Language Packs
│   ├── javascript/  (Babel パーサ + recast プリンタ + Prettier)  ← typescript も同実装を共有
│   ├── html/        (parse5)
│   ├── css/         (postcss)
│   ├── json/
│   ├── prettier-langs/  SCSS / Less / Markdown / YAML / Vue / GraphQL
│   ├── treesitter/  Java / C# / Go / Python / Rust / Ruby / PHP / Kotlin / Swift / C / C++ / Shell / Scala
│   └── external/    gofmt / rustfmt / ruff / black / clang-format / google-java-format / shfmt のアダプタ (Node のみ)
├── pipeline.ts      解析 → 変換 → 検証 → 出力のオーケストレーション
├── node.ts          Node 用の入出力 (フォルダ/ZIP 入力、original/ refined/ レポートの書き出し)
├── cli.ts / ui/     CLI とローカル Web UI (127.0.0.1 のみ)
├── web/             ブラウザ版 (Web Worker + 静的サイト)。`scripts/build-web.mjs` で ./site を生成
```

Core は特定言語・特定ツールに依存しません。Prettier などは **Formatter Adapter**、recast は **Code Printer** として Language Pack の内側に閉じています。

### Language Pack を追加する

`src/languages/types.ts` の `LanguagePack` を実装して登録するだけです (本体の改造は不要)。

```js
// my-pack.mjs
export default {
  id: 'toml', displayName: 'TOML', extensions: ['.toml'],
  formatter: { id: 'my-fmt', format: async (src) => src.trim() + '\n' },
  rules: [],                                   // 一覧表示用: { id, description, level }
  checkSyntax: (src) => ({ ok: true }),        // Parse again 用
  refine: async ({ file, source, config, project }) =>
    ({ code: source.trim() + '\n', changes: [], suggestions: [], warnings: [] }),
  // 任意: analyze() で Semantic Model に寄与 / isEquivalent() / surface()
};
```

設定の `"languagePacks": ["./my-pack.mjs"]`、またはコードから `registry.register(pack)` で有効になります。`refine` の結果は必ず検証ゲートを通ります。

## テスト

```bash
npm test            # 単体 + ゴールデン + システムテスト
UPDATE_GOLDEN=1 npx vitest run tests/golden.test.ts   # ゴールデンの意図的な更新
```

`tests/fixtures/golden-project/` (messy.html / messy.css / messy.js と `expected/`) で次を検証します: 構文が壊れない・動作が変わらない (JS を fake DOM 上で実行して前後比較)・低確信度のものを変更しない・元ファイルが保持される・整形結果が安定 (再実行で変更 0)。
このほか、実在ライブラリ (adm-zip, postcss) を aggressive で変換して挙動が同一であることも確認しています。

## 現時点の制限 / ロードマップ

- **Browser Runtime Analysis** (実ブラウザでの DOM / Console / Network 取得) は計画書どおり後回しで、未実装です。
- 意味解析・リネーム・リファクタリングルールは JS / TS が対象です。HTML / CSS / JSON は構造解析・横断解析・整形・限定的な安全ルール、その他の言語は「対応言語」の表のとおり構文チェック・メトリクス・(ツールがあれば) 整形までです。変数の使用関係・Data Flow・Call Graph を持つ言語は JS / TS だけで、他言語の Call Graph / 未使用コード検出は未対応です。
- Prettier の既定に近い書式で出力します。インデント (タブ/2/4)・引用符・`printWidth` は入力から推定し、プロジェクトの `.prettierrc` (JSON) があれば優先します。
- 型チェックは TypeScript のみ。JS の `checkJs` は対象外です。`node_modules` はコピーされないため、解決できない import による診断は変換前後で相殺されます。
- 解析 (未使用コード・重複・複雑度) の行番号は**元ファイル**のものです。
