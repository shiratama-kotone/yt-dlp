# YouTube ダウンローダー（個人用 Render サーバー）

Node.js + Express + yt-dlp + ffmpeg で動く、個人用の YouTube ダウンロードサーバーです。
1080p 以上など映像・音声が分かれている画質を選んだ場合も、yt-dlp がサーバー内の ffmpeg を
呼び出して自動的に結合し、完成した MP4 を返します。

**必ず個人利用の範囲で、著作権・利用規約を守ってお使いください。**

---

## 1. 構成ファイル

```
.
├── Dockerfile        # yt-dlp / ffmpeg を含む実行環境
├── render.yaml        # Render Blueprint（任意）
├── package.json
├── server.js           # Express本体
├── public/
│   └── index.html       # 操作用Webページ
└── .gitignore
```

Render は通常の Node 環境だと `apt-get` で ffmpeg / yt-dlp を入れられないため、
**Docker デプロイ**にしています（Dockerfile 内で自動インストール）。

---

## 2. デプロイ手順（Render）

1. このフォルダの中身を GitHub リポジトリにアップロードする
   （Chromebook でも GitHub の Web UI から「Add file → Upload files」でOK）
2. Render のダッシュボードで **New → Web Service** を選択
3. 対象のリポジトリを選ぶ
4. Environment を **Docker** にする（Dockerfile を自動検出します）
5. 環境変数を設定する
   - `API_PASSWORD` : 好きなパスワード（**必須**。設定しないと誰でもアクセスできてしまいます）
   - `JOB_TTL_MS` : 任意。ジョブ（一時ファイル）を保持する時間（ミリ秒）。デフォルト 3600000（1時間）
6. Deploy を押す

`render.yaml` を使う場合は **New → Blueprint** からこのリポジトリを指定してください
（`API_PASSWORD` はダッシュボード側で入力を求められます）。

---

## 3. Web ページの使い方

デプロイ後、`https://<your-app>.onrender.com/` にアクセスすると操作画面が開きます。

1. 「パスワード」欄に `API_PASSWORD` と同じ値を入力
2. YouTube の URL を貼り付け、「画質一覧を取得」
3. 一覧から画質を選択（「要結合」バッジがある画質は映像・音声が別々で、
   サーバー側で自動的に ffmpeg 結合されます）。一覧の一番下にある
   「🎵 音声のみ」を選ぶと、映像なしでMP3としてダウンロードできます。
4. 「選択した画質でダウンロード」を押すと処理が始まり、完了すると自動でダウンロードされます

---

## 4. API 仕様

すべてのAPIは以下のいずれかで認証が必要です（`API_PASSWORD` 未設定時は認証スキップ）。

- ヘッダー: `x-api-password: <パスワード>`
- または クエリ / JSONボディ: `password=<パスワード>`

### 4-1. `GET /api/health`
死活監視用。認証不要。

```bash
curl https://<your-app>.onrender.com/api/health
```

### 4-2. `GET /api/formats?url=<動画URL>`
利用可能な画質一覧を取得する。

```bash
curl -H "x-api-password: YOUR_PASSWORD" \
  "https://<your-app>.onrender.com/api/formats?url=https://www.youtube.com/watch?v=XXXX"
```

レスポンス例：

```json
{
  "title": "動画タイトル",
  "thumbnail": "https://...",
  "duration": 245,
  "uploader": "チャンネル名",
  "formats": [
    {
      "formatId": "137",
      "ext": "mp4",
      "resolution": "1080p",
      "height": 1080,
      "hasVideo": true,
      "hasAudio": false,
      "needsMerge": true,
      "filesizeMB": 84.2,
      "note": ""
    }
  ]
}
```

### 4-3. `POST /api/download`
ダウンロードジョブを作成する（非同期）。すぐに `jobId` が返る。

`height` には「この高さ以下でベストな画質」を指定する（`/api/formats` のレスポンスにある
`height` の値を使う。省略・`null` なら無制限＝最高画質）。特定の format_id を直接指定する
方式だと一覧取得時とダウンロード時でYouTube側のitagがズレて失敗することがあるため、
このサーバーでは高さ制約による自動選択方式を採用している。

`audioOnly: true` を指定すると、映像なしでベスト音質からMP3を抽出してダウンロードする
（この場合 `height` は無視される）。

```bash
# 映像（1080p以下でベスト）
curl -X POST -H "Content-Type: application/json" -H "x-api-password: YOUR_PASSWORD" \
  -d '{"url":"https://www.youtube.com/watch?v=XXXX","height":1080}' \
  https://<your-app>.onrender.com/api/download

# 音声のみ(MP3)
curl -X POST -H "Content-Type: application/json" -H "x-api-password: YOUR_PASSWORD" \
  -d '{"url":"https://www.youtube.com/watch?v=XXXX","audioOnly":true}' \
  https://<your-app>.onrender.com/api/download
```

```json
{ "jobId": "5f2c..." }
```

### 4-4. `GET /api/download/:jobId/status`
ジョブの進捗を確認する（2秒間隔程度でポーリングする想定）。

```bash
curl -H "x-api-password: YOUR_PASSWORD" \
  https://<your-app>.onrender.com/api/download/5f2c.../status
```

```json
{ "status": "processing", "error": null, "fileName": null }
```

`status` は `pending` → `processing` → `done`（または `error`）と遷移する。

### 4-5. `GET /api/download/:jobId/file`
完成した MP4 をダウンロードする。**ダウンロード後、サーバー上の一時ファイルは自動削除される**。

```bash
curl -H "x-api-password: YOUR_PASSWORD" \
  -o output.mp4 \
  "https://<your-app>.onrender.com/api/download/5f2c.../file?password=YOUR_PASSWORD"
```

---

## 5. なぜジョブ方式（ポーリング）にしているか

Render の Web サービスにはリクエストのタイムアウトがあり、1080p以上の動画を
その場でダウンロード＆結合して返そうとすると、処理中にタイムアウトしてしまう
ことがあります。

そのため、このサーバーは「ジョブを登録 → バックグラウンドで yt-dlp/ffmpeg 処理 →
完了したらファイルを取得」という非同期方式にしています。これにより：

- 1本のHTTPリクエストが長時間ブロックされない
- 進捗をポーリングで確認できる
- 将来的に処理部分だけ Render の **Background Worker** サービスとして
  切り出すことも容易（下記6章）

---

## 6. Render の Background Worker として分離したい場合

現状は同一プロセス内で「APIサーバー」と「ダウンロード処理」を両方行っています
（個人利用・単一インスタンス前提のシンプルな構成）。

アクセスが増えて処理を分離したくなった場合は、以下のような構成に拡張できます。

1. `processDownloadJob` 相当の処理を、キュー（Redis の List など）から
   ジョブを取り出して実行する別スクリプト（例: `worker.js`）に切り出す
2. Render で **New → Background Worker** を作成し、同じ Dockerfile / リポジトリを指定、
   起動コマンドだけ `node worker.js` に変更する
3. Web サービス側は `POST /api/download` でジョブをキューに積むだけにする
4. ジョブの状態は Redis や DB に保存し、Web / Worker 両方から参照できるようにする

個人利用でアクセスが自分だけなら、現状のインプロセス方式のままで十分動作します。

---

## 7. 「Sign in to confirm you're not a bot」対策（重要）

YouTube が bot 確認を要求してくることがあります。この場合、ログイン済みブラウザの
cookie を yt-dlp に渡す必要があります。

### 手順A: 事前に環境変数へ設定する（デプロイ時）

1. Chrome などに **「Get cookies.txt LOCALLY」** 等の拡張機能を入れる
2. YouTube にログインした状態で `https://www.youtube.com` を開き、拡張機能で
   `cookies.txt`（Netscape形式）をエクスポートする
3. その中身を base64 に変換する（Chromebookのターミナル/Linux環境が使える場合）

   ```bash
   base64 -w0 cookies.txt
   ```

   ターミナルが使えない場合は、オンラインの「Base64 encode」ツールに
   `cookies.txt` の中身を貼り付けて変換してもOKです（内容は自分のログインcookieなので、
   信頼できるツール以外には貼り付けないよう注意してください）。

4. Render の環境変数 `YTDLP_COOKIES_B64` にその文字列を設定して再デプロイする

### 手順B: 再デプロイなしで反映する（cookieが切れた時の更新用）

`POST /api/cookies` に cookies.txt の中身をそのまま（Content-Type: text/plain）送ると、
サーバーを再起動せずに反映できます（※サーバーが再起動すると消えるので、恒久的には
手順Aで環境変数も更新しておくのがおすすめです）。

```bash
curl -X POST \
  -H "x-api-password: YOUR_PASSWORD" \
  -H "Content-Type: text/plain" \
  --data-binary @cookies.txt \
  "https://<your-app>.onrender.com/api/cookies"
```

cookie は数週間〜数ヶ月で失効することがあります。同じエラーが再発した場合は
cookies.txt を取り直して、上記A・Bのどちらかで更新してください。

---

## 8. 「Requested format is not available」対策

原因はおおむね2パターンあります。

### パターンA: PO Token（Proof of Origin）不足
2025年後半以降、YouTubeは有効な PO Token が無いと実際の映像/音声フォーマットを隠し、
「画像のみ」しか返さなくなることがあります（サムネイル的な静止画フォーマットだけが
残り、映像・音声フォーマットがゼロになる）。この場合、どんな画質を選んでも
`Requested format is not available` になります。このサーバーでは
`--extractor-args youtube:formats=missing_pot` を付けて、PO Tokenが無くても
取得できるフォーマットは強制的に一覧へ含めるようにしています（正規のPO Token
プロバイダを別途動かすのが本来のより確実な対策ですが、個人利用ではこの
簡易対策で十分なことが多いです）。

### パターンB: 署名/nチャレンジ解決の失敗
YouTubeの署名解決にJavaScript実行が必要なケースがあり、対応したJSランタイムが
無いと同様のエラーになります。当初はベースイメージのNode.jsを使う想定でしたが、
`yt-dlp-ejs` はNode 22.6未満を "unsupported" として扱うため、ベースイメージの
Node.js（20系）では機能しませんでした。そのため、yt-dlpが標準で最優先に使う
**Deno** を `npm install -g deno` でDockerfileに追加し、`--js-runtimes deno`
で明示的に使うようにしています。

### 原因を実際に確認する（`/api/debug`）
以下のエンドポイントで、実際にどんなフォーマットが（あるいは全く）取得できて
いないか、詳細ログ付きで確認できます。ダウンロードはせず情報取得のみです。

```bash
curl -H "x-api-password: YOUR_PASSWORD" \
  "https://<your-app>.onrender.com/api/debug?url=https://www.youtube.com/watch?v=XXXX"
```

`stdout` に映像/音声フォーマットが1件も並んでいない、あるいは
`WARNING: ... formats have been skipped as they are missing a url` 等が出ていれば
PO Token不足（パターンA）の可能性が高く、`ERROR: Unable to extract ...` や
JS実行系のエラーが出ていればパターンBの可能性があります。

### それでも直らない場合
Dockerfileの `yt-dlp` / `yt-dlp-ejs` のバージョンが古い（ビルドキャッシュが古い）
ことが多いです。Renderのダッシュボードで **Manual Deploy → Clear build cache & deploy**
を実行し、キャッシュなしで再ビルドしてみてください。それでも解消しない場合は、
その時点のYouTube側の仕様変更にyt-dlp本体がまだ追随できていない可能性があります。

---

## 9. トラブルシューティング

- **「画質一覧の取得に失敗しました」** : YouTube 側の仕様変更や年齢制限・地域制限がある
  可能性があります。yt-dlp のバージョンアップで直ることが多いので、Dockerfile の
  `pip3 install --no-cache-dir -U yt-dlp` により毎回最新版が入るようにしています。
  それでも直らない場合は再デプロイ（キャッシュなしビルド）を試してください。
- **ダウンロードが途中で `error` になる** : `status` の `error` メッセージに ffmpeg / yt-dlp
  のエラー内容が入っているので確認してください。無料プランはディスク容量・メモリが
  少ないため、長時間の高画質動画では不足する場合があります。
- **401 Unauthorized** : `API_PASSWORD` とクライアント側で送っているパスワードが
  一致しているか確認してください。