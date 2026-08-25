# NOCTURNE XIII

2〜5人用のオンラインカードゲームです。13階位のカード、4桁のルームコード、構成プリセット、非公開情報を守るサーバー権威型ゲーム処理を備えています。

## 現在の構成

- React 19 + TypeScript + Vite
- Supabase Anonymous Auth / Postgres / Realtime / Edge Functions
- Vitest + Testing Library
- GitHub ActionsによるGitHub Pages公開
- Supabase未接続時にUIとルールを試せるプレビュー対戦

## ローカル起動

Node.js 22以降を使用します。

```bash
npm install
cp .env.example .env.local
npm run dev
```

Supabaseをまだ設定しない場合、環境変数は空のままでも起動できます。この場合は画面に `PREVIEW` と表示され、同じ端末内でルールと操作を確認できます。

## Supabase設定

1. Supabaseプロジェクトを作成します。
2. AuthenticationでAnonymous Sign-Insを有効にします。
3. `supabase/migrations/202608260001_initial.sql` を適用します。
4. `supabase/functions/game-api` をデプロイします。
5. Realtime SettingsでPublic Accessを無効にし、Private Channelを使用します。
6. `.env.local` にProject URLとPublishable Keyを設定します。

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key
VITE_GAME_FUNCTION_NAME=game-api
```

Service Role KeyはEdge Functionの実行環境だけで使用します。ブラウザ、GitHub Actionsの公開ビルド、リポジトリには保存しません。

## GitHub Pages

`.github/workflows/pages.yml` が `main` へのpushでテストとビルドを実行し、`dist` を公開します。

GitHubリポジトリのSettingsでPagesのSourceを `GitHub Actions` に設定し、次のRepository Secretsを登録してください。

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Viteのbase pathはGitHub Actions上のリポジトリ名から自動設定されます。

## 品質確認

```bash
npm run lint
npm test
npm run build
```

## セキュリティ設計

- 4桁コードは部屋を探すための値であり、認証情報ではありません。
- 参加者は匿名認証のJWTとルーム所属の両方で検証されます。
- `game_states` はService Role以外から読み取れません。
- ブラウザにはプレイヤー別に投影した状態だけを返します。
- 他人の手札、山札順、守護状態は投影結果に含めません。
- 各コマンドはUUIDと期待バージョンを持ち、二重処理と競合を防ぎます。
- RealtimeはPrivate ChannelとRLSを使用します。

## 状態遷移

```text
LOBBY
  └─ start
      ↓
DRAW ── 1枚引く ───────────────→ ACTION
  │                                  │
  ├─ 正しい「3枚見る」→ SCHOLAR ───┤
  │                                  │ play
  └─ 誤った「3枚見る」→ RANDOM DROP │
                                     ↓
                              TARGET / RESOLVE
                                     │
                                     ↓
                               WIN CHECK
                                  │     │
                              NEXT TURN END
```

11によるスキップでは実際の手番が始まらないため、4の守護と7の選択権は残ります。カード効果中に山札が尽きた場合は墓地を再び山札にして効果だけを完了し、その後は次の手番へ移らず最終比較を行います。

## 主なファイル

- `supabase/functions/_shared/game.ts` — 純粋なゲームエンジン
- `supabase/functions/game-api/index.ts` — 認証済みゲームコマンド
- `supabase/migrations/` — テーブルとRLS
- `src/App.tsx` — 全画面とプレビュー対戦
- `src/lib/online.ts` — Supabaseクライアント
- `src/game.test.ts` — ルールと非公開情報のテスト

## デザイン

既存ゲームのロゴ、画像、文章を複製せず、カード意匠、名称、画面を独自に制作しています。
