# Netmarble Shop 自動受け取り

Netmarble Shop 日本版で、無料受け取り枠を GitHub Actions から自動実行します。

- 毎日: `[1日1回]` と表示される無料獲得商品
- 毎週: `[週1回]` と表示される無料獲得商品

## 仕組み

- Playwright で `https://slvshop.netmarble.com/ja/item` を開きます。
- 商品名ではなく `[1日1回]` / `[週1回]` の獲得ボタンを探すため、無料商品の名前が変わっても追従しやすくしています。
- ログイン済みセッションがあれば `PLAYWRIGHT_STORAGE_STATE_BASE64` を使います。
- ログイン状態でない場合は `NETMARBLE_EMAIL` / `NETMARBLE_PASSWORD` で自動ログインを試みます。
- GitHub Actions は `workflow_dispatch` で起動します。
- 定刻実行は GitHub Actions の `schedule` ではなく、外部 cron サービスから GitHub API を叩きます。
- メールアドレス、パスワード、Cookie はコードに直接書きません。

## GitHub Secrets

GitHub リポジトリの `Settings` → `Secrets and variables` → `Actions` に追加します。

必須:

```text
NETMARBLE_EMAIL
NETMARBLE_PASSWORD
```

任意:

```text
PLAYWRIGHT_STORAGE_STATE_BASE64
```

`PLAYWRIGHT_STORAGE_STATE_BASE64` はログイン済みセッションです。なくても、メールアドレスとパスワードがあれば自動ログインを試みます。

## 初回セットアップ

依存関係を入れます。

```bash
npm install
npx playwright install chromium
```

ローカルでログイン状態を保存する場合:

```bash
npm run login
```

自動保存を使う場合:

```powershell
$env:AUTO_SAVE='true'
npm run login
```

最後に表示される base64 文字列を `PLAYWRIGHT_STORAGE_STATE_BASE64` に登録できます。

## 外部 cron 実行

cron-job.org などで、以下の GitHub API に `POST` します。

URL:

```text
https://api.github.com/repos/<GitHub Username>/WebShopScript/actions/workflows/claim-netmarble-shop.yml/dispatches
```

Headers:

```text
Accept: application/vnd.github+json
Authorization: Bearer <GitHub Fine-grained PAT>
Content-Type: application/json
X-GitHub-Api-Version: 2022-11-28
```

Daily request body:

```json
{"ref":"main","inputs":{"target":"daily"}}
```

Weekly request body:

```json
{"ref":"main","inputs":{"target":"weekly"}}
```

Fine-grained PAT は、このリポジトリだけに絞って作成します。権限は `Actions: Read and write` と `Contents: Read` を付けます。

## 実行時刻

外部 cron サービス側で次の日本時間に設定します。

- 毎日 09:37 JST: `[1日1回]` の無料獲得商品
- 毎週 木曜 09:42 JST: `[週1回]` の無料獲得商品

GitHub Actions の `schedule` 遅延を避けるため、GitHub 側の cron は使いません。時刻を変える場合は、外部 cron サービス側の設定を変更してください。

## 手動実行

GitHub Actions の `Run workflow` から `daily`、`weekly`、`both` を選べます。

ローカルで試す場合:

```bash
npm run claim:daily
npm run claim:weekly
```

ブラウザ表示でゆっくり確認する場合:

```powershell
$env:HEADLESS='false'
$env:SLOW_MO='2000'
$env:PAUSE_AFTER_DONE='15000'
npm run claim:daily
```

クリックせず検出だけ確認する場合:

```bash
DRY_RUN=true npm run claim:daily
```

## 注意

- CAPTCHA、メール認証、2段階認証、端末確認が出た場合は完全自動化できないことがあります。
- GitHub Actions は無料枠で使えますが、プライベートリポジトリではアカウントの無料分の実行時間を消費します。
- サイト側の UI 文言や仕様が変わると、セレクタ調整が必要になる場合があります。
- 自動化がサービス規約に反しない範囲で使ってください。
